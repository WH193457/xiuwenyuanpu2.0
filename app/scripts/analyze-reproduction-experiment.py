"""CPU-only independent CLIP analysis and complete blind-review material.

Run after the image experiment completes. The scorer never sees method-specific
generation prompts. It compares every image with the eight frozen task targets.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import random
import shutil
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
METHOD_LABELS = {
    "A": "直接任务描述", "B": "直接描述＋本机编排",
    "C": "知识推荐＋分层画布", "D": "知识推荐＋画布＋本机编排",
}


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def safe_json(value):
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def interval(values, resamples, seed):
    import numpy as np
    values = np.asarray(values, dtype=float)
    if not len(values):
        return None
    rng = np.random.default_rng(seed)
    means = values[rng.integers(0, len(values), size=(resamples, len(values)))].mean(axis=1)
    lower, upper = np.quantile(means, [0.025, 0.975])
    return {"mean": float(values.mean()), "ci95": [float(lower), float(upper)], "tasks": len(values)}


def score_images(samples, manifest, model_directory):
    import numpy as np
    import torch
    from PIL import Image
    from transformers import CLIPModel, CLIPProcessor

    torch.set_num_threads(min(8, torch.get_num_threads()))
    processor = CLIPProcessor.from_pretrained(str(model_directory), local_files_only=True)
    model = CLIPModel.from_pretrained(str(model_directory), local_files_only=True).to("cpu").eval()
    targets = [task["evaluationTargetEnglish"] for task in manifest["tasks"]]
    text_inputs = processor(text=targets, return_tensors="pt", padding=True, truncation=False)
    if text_inputs["input_ids"].shape[1] > model.config.text_config.max_position_embeddings:
        raise ValueError("A fixed evaluation target exceeds CLIP's context window")
    with torch.inference_mode():
        text_features = model.get_text_features(**text_inputs)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        for start in range(0, len(samples), 8):
            batch = samples[start:start + 8]
            images = []
            for sample in batch:
                with Image.open(sample["path"]) as image:
                    images.append(image.convert("RGB"))
            inputs = processor(images=images, return_tensors="pt")
            features = model.get_image_features(**inputs)
            features = features / features.norm(dim=-1, keepdim=True)
            similarities = (features @ text_features.T).numpy()
            for sample, scores in zip(batch, similarities):
                target_index = next(index for index, task in enumerate(manifest["tasks"]) if task["id"] == sample["taskId"])
                alternatives = np.delete(scores, target_index)
                sample["clipCosine"] = float(scores[target_index])
                sample["targetMargin"] = float(scores[target_index] - alternatives.max())
                sample["targetTop1"] = bool(int(scores.argmax()) == target_index)
                sample["allTargetCosines"] = {task["id"]: float(score) for task, score in zip(manifest["tasks"], scores)}
            print(f"CLIP CPU scored {min(start + 8, len(samples))}/{len(samples)}", flush=True)
    return {"device": "cpu", "torch": torch.__version__, "transformers": __import__("transformers").__version__,
            "numpy": np.__version__, "pillow": __import__("PIL").__version__,
            "model": manifest["evaluation"]["scoringModel"], "files": {str(path.relative_to(model_directory)): file_hash(path)
            for path in sorted(model_directory.iterdir()) if path.is_file()}}


def summarize(samples, manifest, state):
    import numpy as np
    bootstrap = manifest["evaluation"]["bootstrap"]
    task_means = []
    for task in manifest["tasks"]:
        for method in manifest["methods"]:
            rows = [sample for sample in samples if sample["taskId"] == task["id"] and sample["methodId"] == method["id"]]
            task_means.append({"taskId": task["id"], "methodId": method["id"], "images": len(rows),
                               "complete": len(rows) == manifest["parameters"]["count"],
                               "clipCosine": float(np.mean([row["clipCosine"] for row in rows])) if rows else None,
                               "targetMargin": float(np.mean([row["targetMargin"] for row in rows])) if rows else None})
    methods = []
    for method in manifest["methods"]:
        rows = [row for row in task_means if row["methodId"] == method["id"] and row["complete"]]
        jobs = [job for job in state["jobs"].values() if job["methodId"] == method["id"]]
        token_counts = [job["generation"].get("prompt_token_count") for job in jobs]
        inference = [job["generation"]["inference_seconds"] for job in jobs]
        omitted = [len(job["generation"].get("omitted_concept_ids", [])) for job in jobs]
        method_samples = [sample for sample in samples if sample["methodId"] == method["id"]]
        attempt_times = [attempt["elapsedSeconds"] for attempt in state["attempts"]
                         if attempt["stage"] == "generate" and attempt["status"] == "complete" and attempt["id"].endswith("-" + method["id"])]
        composition_times = [attempt["elapsedSeconds"] for attempt in state["attempts"]
                             if attempt["stage"] == "compose" and attempt["status"] == "complete" and attempt["id"].endswith("-" + method["id"])]
        methods.append({**method, "completedJobs": len(jobs), "plannedJobs": len(manifest["tasks"]),
                        "scoredImages": len(method_samples),
                        "clipCosine": interval([row["clipCosine"] for row in rows], bootstrap["resamples"], bootstrap["seed"]),
                        "targetMargin": interval([row["targetMargin"] for row in rows], bootstrap["resamples"], bootstrap["seed"]),
                        "targetTop1Rate": float(np.mean([sample["targetTop1"] for sample in method_samples])) if method_samples else None,
                        "meanPromptTokens": float(np.mean(token_counts)) if token_counts and all(value is not None for value in token_counts) else None,
                        "totalOmittedConcepts": sum(omitted),
                        "meanCompositionRequestSeconds": float(np.mean(composition_times)) if composition_times else None,
                        "meanBatchInferenceSeconds": float(np.mean(inference)) if inference else None,
                        "meanBatchRequestSeconds": float(np.mean(attempt_times)) if attempt_times else None})
    contrasts = []
    comparisons = [manifest["evaluation"]["primaryComparison"], *manifest["evaluation"]["exploratoryComparisons"]]
    for comparison in comparisons:
        first, second = comparison.split("-")
        differences = []
        for task in manifest["tasks"]:
            paired = {row["methodId"]: row for row in task_means if row["taskId"] == task["id"] and row["complete"]}
            if first in paired and second in paired:
                differences.append({"taskId": task["id"], "delta": paired[first]["clipCosine"] - paired[second]["clipCosine"]})
        contrasts.append({"comparison": comparison, "primary": comparison == manifest["evaluation"]["primaryComparison"],
                          "pairedTaskDifferences": differences,
                          "clipCosineDifference": interval([row["delta"] for row in differences], bootstrap["resamples"], bootstrap["seed"])})
    return {"methods": methods, "taskMeans": task_means, "contrasts": contrasts}


def make_contact_sheets(output, samples, manifest):
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    font_path = next((path for path in [Path("C:/Windows/Fonts/msyh.ttc"), Path("C:/Windows/Fonts/arial.ttf")] if path.exists()), None)
    font = ImageFont.truetype(str(font_path), 18) if font_path else ImageFont.load_default()
    method_font = ImageFont.truetype(str(font_path), 16) if font_path else font
    title_font = ImageFont.truetype(str(font_path), 26) if font_path else font
    directory = output / "contact-sheets"
    directory.mkdir(exist_ok=True)
    paths = []
    for task in manifest["tasks"]:
        sheet = Image.new("RGB", (1120, 1010), "#f6f3ed")
        draw = ImageDraw.Draw(sheet)
        draw.text((24, 16), f"{task['id']} · {task['patternId']} · {task['title']}", font=title_font, fill="#202a32")
        draw.text((24, 54), "同模型 · 同种子 · 512×512 · 30步 · LoRA 0.35", font=font, fill="#485259")
        for column, method in enumerate(manifest["methods"]):
            x = 24 + column * 274
            draw.text((x, 90), f"{method['id']} · {METHOD_LABELS[method['id']]}", font=method_font, fill="#202a32")
            for row, seed in enumerate(task["seeds"]):
                y = 124 + row * 292
                sample = next((item for item in samples if item["taskId"] == task["id"] and item["methodId"] == method["id"] and item["seed"] == seed), None)
                if sample:
                    with Image.open(sample["path"]) as image:
                        sheet.paste(ImageOps.contain(image.convert("RGB"), (256, 256)), (x, y))
                    draw.text((x, y + 260), f"{seed} · CLIP {sample['clipCosine']:.4f}", font=font, fill="#485259")
                else:
                    draw.text((x, y + 100), f"{seed} · 未完成", font=font, fill="#9b392c")
        path = directory / f"{task['id']}.png"
        sheet.save(path)
        paths.append(str(path.relative_to(output)))
    return paths


def make_blind_review(output, samples, manifest, manifest_hash):
    review_directory = output / "blind-review"
    image_directory = review_directory / "images"
    image_directory.mkdir(parents=True, exist_ok=True)
    shuffled = list(samples)
    random.Random(20261109).shuffle(shuffled)
    rows, mapping = [], []
    tasks = {task["id"]: task for task in manifest["tasks"]}
    for index, sample in enumerate(shuffled):
        identifier = f"R{index + 1:03d}"
        destination = image_directory / f"{identifier}.png"
        shutil.copy2(sample["path"], destination)
        rows.append({"id": identifier, "image": str(destination.relative_to(review_directory)).replace("\\", "/"),
                     "task": tasks[sample["taskId"]]["title"],
                     "targetChinese": tasks[sample["taskId"]]["evaluationTargetChinese"],
                     "targetEnglish": tasks[sample["taskId"]]["evaluationTargetEnglish"]})
        mapping.append({"blindId": identifier, "taskId": sample["taskId"], "methodId": sample["methodId"],
                        "seed": sample["seed"], "sha256": sample["sha256"]})
    write_json(output / "blind-mapping-researcher-only.json", {"manifestSha256": manifest_hash, "randomizationSeed": 20261109, "mapping": mapping})
    page = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>侗绣纹样匿名评价</title><style>body{margin:0;background:#f6f3ed;color:#202a32;font:16px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:28px}h1{font-size:27px}label{display:block;margin:14px 0}input,select,textarea,button{font:inherit;padding:8px;border:1px solid #9da4a3;border-radius:4px;background:white}textarea{width:95%}button{cursor:pointer;margin:6px}figure{margin:0}img{width:100%;max-width:512px}article{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:25px}small{color:#56615f}.bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.error{color:#9b392c}@media(max-width:700px){article{grid-template-columns:1fr}}</style>
<main><h1>侗绣纹样匿名评价</h1><p>请根据任务要求逐图评价。1表示很不符合，5表示非常符合。无法判断的项目请保留空白。文化合理性需要相应领域知识。全部图像均为本次实验原始输出。</p>
<label>匿名参与者编号 <input id="participant" maxlength="40" placeholder="例如 P01"></label><label>参与者类型 <select id="role"><option value="">请选择</option><option value="user">用户</option><option value="expert">领域专家</option></select></label>
<p><small>评分仅保存在当前浏览器，完成后点击导出。填写首条评价后参与者编号锁定。请完整分享 blind-review 文件夹。</small></p><div class="bar"><button id="previous">上一张</button><span id="progress"></span><button id="next">下一张</button><button id="download">导出真实评价 JSON</button><button id="new-participant">开始另一位参与者</button></div><p id="status" role="status"></p>
<article><figure><img id="image" alt="待评价的匿名纹样"><figcaption id="caption"></figcaption></figure><section><h2 id="task"></h2><p id="target"></p><details><summary>英文任务描述</summary><p id="target-english"></p></details><div id="questions"></div><label>观察记录<textarea id="notes" rows="4" maxlength="2000"></textarea></label></section></article></main>
<script>
const rows = __ROWS__;
const manifestHash = __HASH__;
const dimensions = [
  ['subject', '主体符合度'], ['composition', '构图符合度'],
  ['embroidery', '刺绣风格表现'], ['culture', '文化合理性'], ['aesthetics', '整体审美']
];
const storageKey = 'xiuwen-blind-' + manifestHash;
let index = 0;
let state = { participant: '', role: '', ratings: {}, identityLocked: false };
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (saved && typeof saved.ratings === 'object' && saved.ratings) state = saved;
} catch {}
const byId = id => document.getElementById(id);
const status = message => { byId('status').textContent = message; };
function hasActualRatings() {
  return Object.values(state.ratings).some(rating =>
    dimensions.some(([key]) => Number.isInteger(rating[key])) || rating.notes?.trim());
}
function identityReady() {
  return Boolean(state.participant) && ['user', 'expert'].includes(state.role);
}
function updateIdentityControls() {
  if (hasActualRatings()) state.identityLocked = true;
  byId('participant').disabled = Boolean(state.identityLocked);
  byId('role').disabled = Boolean(state.identityLocked);
  byId('notes').disabled = !identityReady();
}
function save() {
  updateIdentityControls();
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    status('已在当前浏览器保存');
  } catch {
    status('浏览器保存失败，请立即导出已有评价');
  }
}
function show() {
  const row = rows[index];
  const rating = state.ratings[row.id] || {};
  byId('image').src = row.image;
  byId('caption').textContent = row.id;
  byId('task').textContent = row.task;
  byId('target').textContent = row.targetChinese;
  byId('target-english').textContent = row.targetEnglish;
  byId('progress').textContent = (index + 1) + ' / ' + rows.length;
  byId('previous').disabled = index === 0;
  byId('next').disabled = index === rows.length - 1;
  const questions = byId('questions');
  questions.replaceChildren();
  for (const [key, text] of dimensions) {
    const label = document.createElement('label');
    label.textContent = text + ' ';
    const select = document.createElement('select');
    select.disabled = !identityReady();
    select.add(new Option('未评分 / 无法判断', ''));
    for (let value = 1; value <= 5; value++) select.add(new Option(String(value), String(value)));
    select.value = rating[key] || '';
    select.onchange = () => {
      const current = state.ratings[row.id] || {};
      if (select.value) current[key] = Number(select.value);
      else delete current[key];
      current.updatedAt = new Date().toISOString();
      state.ratings[row.id] = current;
      save();
    };
    label.append(select);
    questions.append(label);
  }
  byId('notes').value = rating.notes || '';
  updateIdentityControls();
}
byId('participant').value = state.participant;
byId('role').value = state.role;
byId('participant').oninput = event => { state.participant = event.target.value.trim(); save(); show(); };
byId('role').onchange = event => { state.role = event.target.value; save(); show(); };
byId('notes').oninput = event => {
  state.ratings[rows[index].id] = {
    ...(state.ratings[rows[index].id] || {}),
    notes: event.target.value,
    updatedAt: new Date().toISOString()
  };
  save();
};
byId('previous').onclick = () => { index = Math.max(0, index - 1); show(); };
byId('next').onclick = () => { index = Math.min(rows.length - 1, index + 1); show(); };
byId('new-participant').onclick = () => {
  if (!confirm('请先导出当前参与者的评价。确定清空当前表单并开始另一位参与者吗？')) return;
  state = { participant: '', role: '', ratings: {}, identityLocked: false };
  index = 0;
  byId('participant').value = '';
  byId('role').value = '';
  save();
  show();
  status('已开始新的参与者记录，请填写新的匿名编号与类型');
};
byId('download').onclick = () => {
  if (!state.participant || !['user', 'expert'].includes(state.role)) {
    status('请填写匿名编号与参与者类型后导出');
    return;
  }
  const actualRatings = Object.entries(state.ratings)
    .filter(([, rating]) => dimensions.some(([key]) => Number.isInteger(rating[key])) || rating.notes?.trim())
    .map(([blindId, rating]) => ({ blindId, ...rating }));
  if (!actualRatings.length) {
    status('请先填写至少一项真实评分或观察记录');
    return;
  }
  const data = {
    schemaVersion: 1, studyType: 'human-blind-image-rating', manifestSha256: manifestHash,
    exportedAt: new Date().toISOString(), participant: state.participant,
    role: state.role, ratings: actualRatings
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'blind-ratings-' + state.participant.replace(/[^a-z0-9_-]/gi, '_') + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('已导出实际填写的评价');
};
show();
</script></html>"""
    page = page.replace("__ROWS__", safe_json(rows)).replace("__HASH__", safe_json(manifest_hash))
    (review_directory / "index.html").write_text(page, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "outputs" / "reproduction-2026-11-09")
    parser.add_argument("--model", type=Path, default=PROJECT_ROOT / ".model-cache" / "clip-vit-base-patch32")
    args = parser.parse_args()
    output = args.output.resolve()
    manifest, state = read_json(output / "manifest.json"), read_json(output / "experiment-state.json")
    manifest_hash = file_hash(output / "manifest.json")
    if manifest_hash != state["manifestSha256"] or manifest_hash != (output / "manifest.sha256").read_text().split()[0]:
        raise ValueError("Manifest checksum mismatch")
    samples = []
    from PIL import Image
    from structure_metrics import structure_metrics
    tasks = {task["id"]: task for task in manifest["tasks"]}
    for identifier, job in state["jobs"].items():
        generation = job["generation"]
        for index, candidate in enumerate(generation["candidates"]):
            path = Path(candidate["path"])
            if file_hash(path) != candidate["sha256"]:
                raise ValueError(f"Image checksum changed for {identifier}-{index}")
            task_plan = tasks[job["taskId"]]["taskPlan"]
            with Image.open(path) as image:
                metrics = structure_metrics(image, task_plan, [concept["id"] for concept in task_plan["concepts"]])
            samples.append({"id": f"{identifier}-{index + 1}", "taskId": job["taskId"], "methodId": job["methodId"],
                            "seed": candidate["seed"], "path": str(path), "sha256": candidate["sha256"],
                            "taskRequestedStructureMetrics": metrics})
    if not samples:
        raise ValueError("No completed experimental images exist")
    analysis_snapshot = output / "source-snapshot" / "scripts" / Path(__file__).name
    analysis_snapshot.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(__file__), analysis_snapshot)
    scorer = score_images(samples, manifest, args.model.resolve())
    planned_images = len(manifest["jobs"]) * manifest["parameters"]["count"]
    generation_attempts = [attempt for attempt in state["attempts"] if attempt["stage"] == "generate"]
    successful_generation_attempts = [attempt for attempt in generation_attempts if attempt["status"] == "complete"]
    stage_counts = {}
    for stage in ("compose", "preview", "generate"):
        attempts = [attempt for attempt in state["attempts"] if attempt["stage"] == stage]
        stage_counts[stage] = {"attempts": len(attempts), "succeeded": sum(attempt["status"] == "complete" for attempt in attempts),
                               "failed": sum(attempt["status"] == "failed" for attempt in attempts)}
    summary = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "manifestSha256": manifest_hash, "analysisScriptSha256": file_hash(Path(__file__)),
               "plannedImages": planned_images, "scoredImages": len(samples), "plannedImageCompletionRate": len(samples) / planned_images,
               "plannedJobs": len(manifest["jobs"]), "completedJobs": len(state["jobs"]),
               "pipelineJobCompletionRate": len(state["jobs"]) / len(manifest["jobs"]),
               "completionRateDefinition": "Completed image jobs and images divided by all planned jobs and images. The image-generation HTTP success rate uses only actual generation attempts.",
               "generationAttempts": len(generation_attempts), "successfulGenerationAttempts": len(successful_generation_attempts),
               "generationAttemptSuccessRate": len(successful_generation_attempts) / len(generation_attempts) if generation_attempts else None,
               "stageAttemptCounts": stage_counts,
               "scorer": scorer, "evaluationProtocol": manifest["evaluation"], **summarize(samples, manifest, state),
               "samples": samples, "failedAttempts": [attempt for attempt in state["attempts"] if attempt["status"] != "complete"],
               "preparationFailures": state.get("preparationFailures", {}), "generationFailures": state.get("generationFailures", {}),
               "uncompletedJobs": [job for job in manifest["jobs"] if job["id"] not in state["jobs"]],
               "humanRatingsCollected": 0,
               "limitations": ["Eight purposively selected in-domain tasks; annotated references may overlap LoRA training material.",
                               "CLIP cosine and retrieval margin are model-based similarity proxies, with no cultural or aesthetic ground truth.",
                               "Automated graph adoption does not measure human interaction workload or creative agency.",
                               "Cold-start request latency and model composition latency are recorded separately from image inference time.",
                               "Paired contrasts use complete tasks only. A method-dependent preparation failure creates non-random missingness and may bias complete-case comparisons. Missing scores are never imputed."]}
    write_json(output / "summary.json", summary)
    sheets = make_contact_sheets(output, samples, manifest)
    make_blind_review(output, samples, manifest, manifest_hash)
    rows = []
    for method in summary["methods"]:
        metric = method["clipCosine"]
        value = f"{metric['mean']:.4f}" if metric else "无已完成任务"
        rows.append(f"<tr><td>{html.escape(method['id'] + ' · ' + METHOD_LABELS[method['id']])}</td><td>{method['scoredImages']}</td><td>{value}</td><td>{method['totalOmittedConcepts']}</td></tr>")
    figures = ''.join(f'<figure><img src="{html.escape(path)}" alt="全部种子与方法对照"><figcaption>{html.escape(Path(path).stem)} 原始输出</figcaption></figure>' for path in sheets)
    incomplete_rows = []
    for job in summary["uncompletedJobs"]:
        failure = state.get("preparationFailures", {}).get(job["id"]) or state.get("generationFailures", {}).get(job["id"], {})
        stage = "提示词准备失败，图像生成未启动" if job["id"] in state.get("preparationFailures", {}) else "图像生成未完成"
        incomplete_rows.append(f"<li><strong>{html.escape(job['id'])} · {html.escape(stage)}</strong><p>{html.escape(failure.get('error', '缺少完成记录'))}</p></li>")
    failure_section = f"<section class='failures'><h2>未完成任务</h2><ul>{''.join(incomplete_rows)}</ul></section>" if incomplete_rows else ""
    stages_text = (f"语言编排请求成功 {stage_counts['compose']['succeeded']}/{stage_counts['compose']['attempts']}，"
                   f"图像生成请求成功 {stage_counts['generate']['succeeded']}/{stage_counts['generate']['attempts']}。"
                   f"完整流程完成 {len(state['jobs'])}/{len(manifest['jobs'])} 组。"
                   f"全部计划图像的完成比例为 {len(samples)}/{planned_images}。")
    contrast_rows = []
    for contrast in summary["contrasts"]:
        values = contrast["clipCosineDifference"]
        if values:
            contrast_rows.append(f"<tr><td>{contrast['comparison']}{' · 主要比较' if contrast['primary'] else ' · 探索性比较'}</td><td>{values['tasks']}</td><td>{values['mean']:+.4f}</td><td>[{values['ci95'][0]:+.4f}, {values['ci95'][1]:+.4f}]</td></tr>")
    contrast_table = f"<h2>配对任务比较</h2><p>每个任务先平均3个相同种子的结果，再以完整配对任务为单位计算差值及 bootstrap 区间。仅完整配对任务进入对应比较。方法自身的准备失败造成非随机缺失，完整任务比较可能存在偏倚；缺失图像与分数保持缺失。</p><table><thead><tr><th>比较</th><th>配对任务数</th><th>CLIP 平均差</th><th>95% 区间</th></tr></thead><tbody>{''.join(contrast_rows)}</tbody></table>"
    page = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PromptTCP 本地对照实验</title><style>body{{background:#f6f3ed;color:#202a32;font:16px/1.7 system-ui,sans-serif;margin:0}}main{{max-width:1140px;margin:auto;padding:28px}}h1{{font-size:28px}}table{{border-collapse:collapse;width:100%}}th,td{{text-align:left;border-bottom:1px solid #b8bfbc;padding:12px}}figure{{margin:30px 0}}img{{max-width:100%;height:auto}}a{{color:#24645d}}.failures{{border:1px solid #9b392c;padding:18px;overflow-wrap:anywhere}}</style><main><h1>PromptTCP 本地对照实验</h1><p>已评分 {len(samples)} / {planned_images} 张图像。任务、种子、参数与选择规则在生成前固定。全部候选按方法和种子呈现。</p><p>四种方法共用 SD1.5 与侗绣 LoRA，强度0.35，其他生成参数和配对种子相同。本机编排按整张画布的上下文处理概念组；单个已有英文的非主体原子条件在推理前原样保留，记录 origin=preserved，其余需编排组由本机 Qwen 处理并记录 origin=model。这是明确公开的本地适配方案。</p><p>{stages_text}</p>{failure_section}<p>CLIP 是独立模型计算的文本图像相似度。真人用户与专家评分尚待采集。</p><table><thead><tr><th>方法</th><th>图像数</th><th>任务平均 CLIP</th><th>省略条件总数</th></tr></thead><tbody>{''.join(rows)}</tbody></table>{contrast_table}<p><a href="summary.json">完整统计与逐图记录</a> · <a href="manifest.json">预先固定的实验方案</a> · <a href="blind-review/index.html">匿名图像评价表</a></p>{figures}</main></html>'''
    (output / "index.html").write_text(page, encoding="utf-8")
    print(json.dumps({"scoredImages": len(samples), "summary": str(output / "summary.json"), "contrasts": summary["contrasts"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

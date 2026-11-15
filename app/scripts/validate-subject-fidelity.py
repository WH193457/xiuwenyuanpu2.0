"""Frozen known-task validation of the subject-fidelity generation profile.

Reuses all original A/C images, task targets and paired seeds. Generates only
eight F batches (24 images), then scores all 72 images with the same local CLIP.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import html
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load_script("paired_runner", "run-reproduction-experiment.py")
analysis = load_script("paired_analysis", "analyze-reproduction-experiment.py")
LABELS = {"A": "原直接描述", "C": "原知识画布", "F": "改进知识画布"}
PRIMARY_METRIC = (
    "Normalized CLIP image-text cosine against the same fixed evaluationTargetEnglish "
    "for all three methods (A, C, F) in each task. This score is not a probability."
)
SOURCE_FILES = [
    "lora_service.py", "prompt_plan.py", "generation_policy.py", "semantic_checks.py", "structure_metrics.py",
    "local_language.py", "scripts/run-reproduction-experiment.py", "scripts/analyze-reproduction-experiment.py",
    "scripts/validate-subject-fidelity.py",
]


def read_baseline(directory):
    manifest = runner.read_json(directory / "manifest.json")
    state = runner.read_json(directory / "experiment-state.json")
    digest = runner.file_hash(directory / "manifest.json")
    if digest != state["manifestSha256"] or digest != (directory / "manifest.sha256").read_text().split()[0]:
        raise ValueError("The original frozen protocol checksum changed")
    baseline_jobs = {}
    for task in manifest["tasks"]:
        for method in ("A", "C"):
            identifier = f"{task['id']}-{method}"
            job = state["jobs"][identifier]
            runner.verify_generation(job["generation"], task, manifest["parameters"],
                                     state["preparations"][identifier]["preview"], manifest["expectedCompiler"])
            baseline_jobs[identifier] = deepcopy(job)
    return manifest, state, baseline_jobs


def make_manifest(baseline_directory):
    previous, state, baselines = read_baseline(baseline_directory)
    exploration = []
    for name in ("subject-fidelity-exploration-2026-11-09", "subject-fidelity-ablation-2026-11-09"):
        path = ROOT / "outputs" / name / "records.json"
        records = runner.read_json(path)
        exploration.append({"path": str(path), "sha256": runner.file_hash(path), "images": len(records),
                            "interpretation": "Engineering exploration informed the frozen policy; not independent confirmation"})
    return {
        "schemaVersion": 1, "experimentId": "subject-fidelity-known-tasks-2026-11-09", "createdAt": runner.utc_now(),
        "studyType": "known-task-paired-improvement-validation", "expectedCompiler": "dong-semantic-plan-6",
        "expectedPolicy": "subject-fidelity-1", "newProfile": "subject-fidelity",
        "parameters": deepcopy(previous["parameters"]), "tasks": deepcopy(previous["tasks"]),
        "methods": [{"id": "A", "name": "archived-direct-task"}, {"id": "C", "name": "archived-knowledge-canvas"},
                    {"id": "F", "name": "knowledge-canvas-subject-fidelity"}],
        "newJobs": [{"id": f"{task['id']}-F", "taskId": task["id"], "methodId": "F",
                     "payload": {**deepcopy(state["preparations"][f"{task['id']}-C"]["payload"]), "generation_profile": "subject-fidelity"}}
                    for task in previous["tasks"]],
        "baselineJobs": baselines,
        "evaluation": {**deepcopy(previous["evaluation"]), "primaryAutomaticMetric": PRIMARY_METRIC,
                       "primaryComparison": "F-C", "exploratoryComparisons": ["F-A"]},
        "scope": "24 new F images compared with all 24 original C images and all 24 original A images. Every arm uses SD1.5, the identical LoRA weights and static strength 0.35, 30 steps, CFG 7.2 and 512x512. F changes text conditioning through the versioned profile only.",
        "selectionPolicy": "Retain every output and failure. No new seed selection, strength tuning, baseline substitution or post-generation prompt editing.",
        "interpretation": "The tasks and some seeds were already examined during development. This measures improvement on known tasks, with descriptive paired uncertainty, and does not establish held-out generalization or human-rated quality.",
        "explorationEvidence": exploration,
        "provenance": {"baselineDirectory": str(baseline_directory),
                       "baselineManifestSha256": runner.file_hash(baseline_directory / "manifest.json"),
                       "baselineStateSha256": runner.file_hash(baseline_directory / "experiment-state.json"),
                       "baselineSummarySha256": runner.file_hash(baseline_directory / "summary.json"),
                       "models": deepcopy(state["environment"]["models"]),
                       "sourceHashes": {name: runner.file_hash(ROOT / name) for name in SOURCE_FILES}},
    }


def local_api():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return lambda endpoint, payload=None: runner.request_json(opener, "http://127.0.0.1:8001", endpoint, payload)


def check_preview(preview, baseline, manifest):
    if preview.get("compiler_version") != manifest["expectedCompiler"] or preview.get("generation_profile") != manifest["newProfile"]:
        raise ValueError("The preview did not use the frozen compiler/profile")
    policy = preview.get("generation_policy", {})
    if policy.get("version") != manifest["expectedPolicy"]:
        raise ValueError("The generation policy version differs from the protocol")
    if preview.get("semantic_plan") != baseline["semantic_plan"]:
        raise ValueError("The new profile changed the original knowledge plan")
    if set(preview.get("applied_concept_ids", [])) != set(baseline.get("applied_concept_ids", [])):
        raise ValueError("The new profile changed which original concepts survive compilation")
    if preview.get("omitted_concept_ids"):
        raise ValueError("The new profile omitted an original concept")
    if preview.get("prompt_token_count", 0) > 77 or policy.get("negative_token_count", 0) > 77:
        raise ValueError("The profile exceeded CLIP's positive or negative token limit")


def freeze(output, baseline_directory):
    manifest = make_manifest(baseline_directory)
    api = local_api()
    health = api("/api/lora/health")
    if health.get("compiler_version") != manifest["expectedCompiler"] or manifest["newProfile"] not in health.get("generation_profiles", []):
        raise ValueError("Restart the service with compiler6 and the subject-fidelity profile before freezing")
    for job in manifest["newJobs"]:
        standard = api("/api/lora/preview", {**job["payload"], "generation_profile": "standard"})
        original = manifest["baselineJobs"][f"{job['taskId']}-C"]["generation"]
        if standard["prompt"] != original["prompt"] or standard["negative_prompt"] != original["negative_prompt"]:
            raise ValueError(f"The standard profile no longer reproduces archived C text for {job['id']}")
        preview = api("/api/lora/preview", job["payload"])
        check_preview(preview, original, manifest)
        if job["taskId"] in ("T05", "T08"):
            policy = preview["generation_policy"]
            if not policy["repeat_requested"] or policy["layout"] != "horizontal-band":
                raise ValueError(f"The profile failed to retain the horizontal repeat requirement for {job['id']}")
            if "repeating pattern" in policy["negative_terms"] or "tiled" in policy["negative_terms"]:
                raise ValueError(f"The profile contradicted the repeat requirement for {job['id']}")
        job["preview"] = preview
    manifest["healthAtFreeze"] = health
    output.mkdir(parents=True, exist_ok=True)
    path = output / "manifest.json"
    with path.open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    with (output / "manifest.sha256").open("x", encoding="utf-8") as stream:
        stream.write(runner.file_hash(path) + "  manifest.json\n")
    for relative, digest in manifest["provenance"]["sourceHashes"].items():
        if runner.file_hash(ROOT / relative) != digest:
            raise ValueError(f"Source changed during freeze {relative}")
        destination = output / "source-snapshot" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)
    print(f"Frozen 8 tasks, 24 new images and 48 original baseline images: {runner.file_hash(path)}", flush=True)


def validate_frozen(output):
    manifest = runner.read_json(output / "manifest.json")
    digest = runner.file_hash(output / "manifest.json")
    if digest != (output / "manifest.sha256").read_text().split()[0]:
        raise ValueError("Protocol checksum changed")
    for relative, expected in manifest["provenance"]["sourceHashes"].items():
        if runner.file_hash(ROOT / relative) != expected or runner.file_hash(output / "source-snapshot" / relative) != expected:
            raise ValueError(f"Frozen generation/analysis source changed {relative}")
    for name in ("base", "lora"):
        model = manifest["provenance"]["models"][name]
        if runner.file_hash(Path(model["path"])) != model["sha256"]:
            raise ValueError(f"Generation model changed {name}")
    return manifest, digest


def run_images(output):
    manifest, digest = validate_frozen(output)
    api = local_api()
    health = api("/api/lora/health")
    if health.get("active_task") or health.get("queued_tasks"):
        raise ValueError("The shared inference service is busy")
    state_path = output / "state.json"
    state = runner.read_json(state_path) if state_path.exists() else {
        "manifestSha256": digest, "startedAt": runner.utc_now(), "jobs": deepcopy(manifest["baselineJobs"]), "attempts": [], "failures": {}}
    if state["manifestSha256"] != digest:
        raise ValueError("The checkpoint belongs to a different protocol")
    (output / "attempts").mkdir(exist_ok=True)
    tasks = {task["id"]: task for task in manifest["tasks"]}
    for job in manifest["newJobs"]:
        identifier = job["id"]
        if identifier in state["jobs"]:
            runner.verify_generation(state["jobs"][identifier]["generation"], tasks[job["taskId"]], manifest["parameters"],
                                     job["preview"], manifest["expectedCompiler"])
            continue
        started = time.monotonic()
        attempt = {"id": identifier, "stage": "generate", "status": "running", "startedAt": runner.utc_now()}
        state["attempts"].append(attempt)
        runner.write_json(state_path, state)
        try:
            record = runner.stripped_generation(api("/api/lora/generate", job["payload"]))
            runner.write_json(output / "attempts" / f"{len(state['attempts']):02d}-{identifier}.json", record)
            runner.verify_generation(record, tasks[job["taskId"]], manifest["parameters"], job["preview"], manifest["expectedCompiler"])
            check_preview(record, manifest["baselineJobs"][f"{job['taskId']}-C"]["generation"], manifest)
            if record["generation_policy"] != job["preview"]["generation_policy"]:
                raise ValueError("Actual policy differs from the frozen preview")
            for candidate in record["candidates"]:
                candidate["sha256"] = runner.file_hash(Path(candidate["path"]))
            record["metadataSha256"] = runner.file_hash(Path(record["metadata_path"]))
            state["jobs"][identifier] = {"taskId": job["taskId"], "methodId": "F", "generation": record}
            state["failures"].pop(identifier, None)
            attempt["status"] = "complete"
            print(f"generated {identifier}: 3 images, {record['inference_seconds']} s", flush=True)
        except Exception as error:
            attempt.update(status="failed", error=str(error))
            state["failures"][identifier] = {**job, "error": str(error)}
            print(f"failed {identifier}: {error}", flush=True)
        finally:
            attempt.update(endedAt=runner.utc_now(), elapsedSeconds=round(time.monotonic() - started, 4))
            runner.write_json(state_path, state)
    state["finishedAt"] = runner.utc_now()
    state["status"] = "partial" if state["failures"] else "complete"
    runner.write_json(state_path, state)


def contact_sheets(output, manifest, samples):
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    regular = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    heading = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 25)
    directory = output / "contact-sheets"
    directory.mkdir(exist_ok=True)
    for task in manifest["tasks"]:
        sheet = Image.new("RGB", (850, 1010), "#f6f3ed")
        draw = ImageDraw.Draw(sheet)
        draw.text((22, 16), f"{task['id']} · {task['title']}", font=heading, fill="#202a32")
        draw.text((22, 54), "固定原种子 · 同LoRA强度0.35 · 全部候选", font=regular, fill="#485259")
        for column, method in enumerate(manifest["methods"]):
            x = 22 + column * 276
            draw.text((x, 90), f"{method['id']} · {LABELS[method['id']]}", font=regular, fill="#202a32")
            for row, seed in enumerate(task["seeds"]):
                y = 124 + row * 292
                sample = next((item for item in samples if item["taskId"] == task["id"] and item["methodId"] == method["id"] and item["seed"] == seed), None)
                if sample:
                    with Image.open(output / sample["image"]) as image:
                        sheet.paste(ImageOps.contain(image.convert("RGB"), (256, 256)), (x, y))
                    draw.text((x, y + 260), f"{seed} · CLIP {sample['clipCosine']:.4f}", font=regular, fill="#485259")
                else:
                    draw.text((x, y + 100), f"{seed} · 未完成", font=regular, fill="#9b392c")
        sheet.save(directory / f"{task['id']}.png")


def analyze(output):
    manifest, digest = validate_frozen(output)
    state = runner.read_json(output / "state.json")
    samples = []
    for identifier, job in state["jobs"].items():
        for candidate in job["generation"]["candidates"]:
            source = Path(candidate["path"])
            if runner.file_hash(source) != candidate["sha256"]:
                raise ValueError(f"Original image changed {source}")
            destination = output / "images" / job["methodId"] / f"{job['taskId']}-{candidate['seed']}.png"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            samples.append({"id": f"{identifier}-{candidate['seed']}", "taskId": job["taskId"], "methodId": job["methodId"],
                            "seed": candidate["seed"], "path": str(destination), "originalPath": str(source),
                            "image": str(destination.relative_to(output)).replace("\\", "/"), "sha256": candidate["sha256"]})
    scorer = analysis.score_images(samples, manifest, ROOT / ".model-cache" / "clip-vit-base-patch32")
    previous_summary = runner.read_json(Path(manifest["provenance"]["baselineDirectory"]) / "summary.json")
    original_scores = {(sample["taskId"], sample["methodId"], sample["seed"]): sample["clipCosine"] for sample in previous_summary["samples"]}
    baseline_score_drift = max(abs(sample["clipCosine"] - original_scores[(sample["taskId"], sample["methodId"], sample["seed"])])
                               for sample in samples if sample["methodId"] != "F")
    if baseline_score_drift > 0.00001:
        raise ValueError("CLIP recomputation differs materially from the original archived baseline scores")
    new_images = sum(sample["methodId"] == "F" for sample in samples)
    summary = {"schemaVersion": 1, "createdAt": runner.utc_now(), "manifestSha256": digest,
               "studyType": manifest["studyType"], "plannedNewImages": 24, "completedNewImages": new_images,
               "baselineImages": len(samples) - new_images, "totalScoredImages": len(samples),
               "actualGenerationAttempts": len(state["attempts"]),
               "successfulGenerationAttempts": sum(attempt["status"] == "complete" for attempt in state["attempts"]),
               "baselineScoreMaximumDrift": baseline_score_drift, "scorer": scorer,
               **analysis.summarize(samples, manifest, state), "samples": samples, "failures": state["failures"],
               "evaluation": {**deepcopy(manifest["evaluation"]), "primaryAutomaticMetric": PRIMARY_METRIC}, "humanRatingsCollected": 0,
               "limitations": [manifest["interpretation"], "CLIP similarity is an automatic proxy and cannot establish cultural correctness or aesthetic quality.",
                               "F changes a combined text-conditioning policy. This validation does not isolate the contribution of each individual compiler or negative-prompt rule.",
                               "Earlier engineering exploration used some of these tasks and seeds. All original and new outputs remain available; no best-image selection is used."]}
    runner.write_json(output / "summary.json", summary)
    contact_sheets(output, manifest, samples)
    method_rows = []
    for method in summary["methods"]:
        score = method["clipCosine"]
        displayed = f"{score['mean']:.4f}" if score else "未完成"
        retrieval = f"{method['targetTop1Rate']:.1%}" if method['targetTop1Rate'] is not None else "未完成"
        method_rows.append(f"<tr><td>{method['id']} · {LABELS[method['id']]}</td><td>{method['scoredImages']}</td><td>{displayed}</td><td>{retrieval}</td></tr>")
    contrast_rows = []
    for contrast in summary["contrasts"]:
        value = contrast["clipCosineDifference"]
        if value:
            contrast_rows.append(f"<tr><td>{contrast['comparison']}{' 主要比较' if contrast['primary'] else ' 次要比较'}</td><td>{value['tasks']}</td><td>{value['mean']:+.4f}</td><td>[{value['ci95'][0]:+.4f}, {value['ci95'][1]:+.4f}]</td></tr>")
    figures = ''.join(f'<figure><img src="contact-sheets/{task["id"]}.png" alt="{html.escape(task["title"])}全部候选对照"></figure>' for task in manifest["tasks"])
    failures = ''.join(f'<li>{html.escape(identifier)} · {html.escape(record["error"])}</li>' for identifier, record in state["failures"].items())
    failure_section = f"<h2>未完成任务</h2><ul>{failures}</ul>" if failures else ""
    page = f'''<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>主体与构图改进验证</title>
  <style>
    body {{ margin:0; background:#f6f3ed; color:#202a32; font:16px/1.7 system-ui,sans-serif; }}
    main {{ max-width:1100px; margin:auto; padding:28px; }}
    h1 {{ font-size:28px; }}
    h2 {{ font-size:22px; }}
    table {{ width:100%; border-collapse:collapse; }}
    td, th {{ text-align:left; padding:10px; border-bottom:1px solid #b8bfbc; }}
    figure {{ margin:28px 0; }}
    img {{ max-width:100%; height:auto; }}
    a {{ color:#24645d; }}
    li {{ overflow-wrap:anywhere; }}
  </style>
</head>
<body><main>
  <h1>主体与构图改进验证</h1>
  <p>新增 {new_images}/24 张图像，连同原 A、C 组48张原图，共评分 {len(samples)} 张。
  三个组共用 SD1.5、同一侗绣 LoRA、静态强度0.35、原三个固定种子和生成参数。
  F使用 subject-fidelity-1 编译与负向条件策略，原 C 组语义方案完整保留。</p>
  <p>本轮在已用于开发观察的8个任务上检验改进。先前32张工程探索和18张消融结果完整保留。
  任务已参与策略选择，当前结果的解释范围为已知任务集。</p>
  {failure_section}
  <table>
    <thead><tr><th>组别</th><th>图像数</th><th>任务平均 CLIP</th><th>8任务目标检索首位比例</th></tr></thead>
    <tbody>{''.join(method_rows)}</tbody>
  </table>
  <h2>配对任务比较</h2>
  <p>每任务先平均3个种子，按完整配对任务进行10000次 bootstrap。
  CLIP为固定任务文本的自动相似度，文化、审美和边框评价仍需真实人工评价。</p>
  <table>
    <thead><tr><th>比较</th><th>任务数</th><th>CLIP平均差</th><th>95%区间</th></tr></thead>
    <tbody>{''.join(contrast_rows)}</tbody>
  </table>
  <p><a href="manifest.json">冻结方案与完整提示词</a> ·
  <a href="summary.json">逐图指标与统计</a> · <a href="state.json">实际生成记录</a></p>
  {figures}
</main></body></html>'''
    (output / "index.html").write_text(page, encoding="utf-8")
    print(json.dumps({"newImages": new_images, "scoredImages": len(samples), "contrasts": summary["contrasts"],
                      "baselineScoreMaximumDrift": baseline_score_drift}, ensure_ascii=False, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("check", "freeze", "generate", "analyze", "all"))
    parser.add_argument("--output", type=Path, default=ROOT / "outputs" / "subject-fidelity-validation-2026-11-09")
    parser.add_argument("--baseline", type=Path, default=ROOT / "outputs" / "reproduction-2026-11-09-v2")
    args = parser.parse_args()
    output, baseline = args.output.resolve(), args.baseline.resolve()
    if args.stage == "check":
        manifest = make_manifest(baseline)
        print(json.dumps({"tasks": len(manifest["tasks"]), "newJobs": len(manifest["newJobs"]),
                          "newImages": 24, "baselineJobs": len(manifest["baselineJobs"]),
                          "explorationImages": sum(row["images"] for row in manifest["explorationEvidence"])}, indent=2))
        return
    output.mkdir(parents=True, exist_ok=True)
    lock = output / ".validation.lock"
    with lock.open("x", encoding="utf-8") as stream:
        stream.write(runner.utc_now())
    try:
        if args.stage in ("freeze", "all") and not (output / "manifest.json").exists():
            freeze(output, baseline)
        if args.stage in ("generate", "all"):
            run_images(output)
        if args.stage in ("analyze", "all"):
            analyze(output)
    finally:
        lock.unlink()


if __name__ == "__main__":
    main()

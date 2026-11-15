"""Prepare, freeze, run and analyze a 6-task, 3-seed, 4-arm reference study.

The draft command prints the proposed configuration without inference or writes.
Freeze requires the reviewed configuration file. Generation is a separate stage.
All 72 outputs are newly generated through the regular local HTTP endpoint.
"""

from __future__ import annotations

import argparse
import ast
from copy import deepcopy
import html
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_script(name, filename):
    specification = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


runner = load_script("reference_validation_runner", "run-reproduction-experiment.py")
analysis = load_script("reference_validation_analysis", "analyze-reproduction-experiment.py")
METHODS = [
    {"id": "T", "name": "subject-fidelity-text-only", "label": "主体优先文本"},
    {"id": "I", "name": "stitched-reference-img2img", "label": "针线参考图生图"},
    {"id": "F", "name": "flat-reference-canny-img2img", "label": "平面参考＋轮廓"},
    {"id": "R", "name": "stitched-reference-canny-img2img", "label": "针线参考＋轮廓"},
]
PARAMETERS = {"count": 3, "steps": 30, "guidance": 7.2, "width": 512, "height": 512, "lora_scale": 0.35}
SOURCE_FILES = [
    "lora_service.py", "reference_conditioning.py", "embroidery_material.py", "prompt_plan.py", "generation_policy.py",
    "semantic_checks.py", "structure_metrics.py", "local_language.py", "local_vision.py",
    "scripts/run-reproduction-experiment.py", "scripts/analyze-reproduction-experiment.py",
    "scripts/validate-reference-control.py",
]
METRICS = {
    "maskIoU": {"label": "主体区域IoU", "higherIsBetter": True},
    "boundaryF1": {"label": "轮廓容差F1", "higherIsBetter": True},
    "foregroundDeltaE76": {"label": "主体区域色差", "higherIsBetter": False},
    "backgroundDeltaE76": {"label": "背景区域色差", "higherIsBetter": False},
    "marginForegroundRate": {"label": "空白边缘主体色比例", "higherIsBetter": False},
    "marginEdgeDensity": {"label": "空白边缘低频边缘比例", "higherIsBetter": False},
    "clipCosine": {"label": "CLIP余弦", "higherIsBetter": True},
}
PIXEL_PROTOCOL = {
    "colorSpace": "CIE Lab D65; Euclidean DeltaE76", "segmentationBlurSigma": 1.0,
    "maskThreshold": 128, "boundaryTolerancePixels": 3, "foregroundErosionPixels": 2,
    "backgroundExclusionPixels": 6, "marginFraction": 0.08,
    "marginEdgeBlurSigma": 2.0, "marginCannyThresholds": [80, 160],
}


def literal_constant(filename, name):
    """Read a backend constant without importing its service/logging side effects."""
    tree = ast.parse((ROOT / filename).read_text(encoding="utf-8-sig"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f"Missing literal constant {filename}:{name}")


def draft_config():
    specifications = [
        ("Q01", "DX027", 910101, "红蝶蓝底", "a single red butterfly", "blue", "#D12D3E", "#25549A", "dark", 190, [0, 0, 1, 1], "centered", "centered composition, bilateral symmetry, empty margins"),
        ("Q02", "DX027", 920201, "蓝蝶米白底", "a single blue butterfly", "ivory", "#25549A", "#F5F0E6", "dark", 190, [0, 0, 1, 1], "centered", "centered composition, bilateral symmetry, empty margins"),
        ("Q03", "DX013", 930301, "白八角星蓝底", "a single white eight-pointed star", "blue", "#F5F0E6", "#25549A", "light", 245, [0, 0, 1, 1], "centered", "centered radial composition, eight points, empty margins"),
        ("Q04", "DX017", 940401, "黑色三连臂人形", "three black geometric human figures joining arms", "ivory", "#17191D", "#F5F0E6", "dark", 140, [0, 0.04, 1, 0.73], "horizontal-band", "one horizontal row, three connected figures, empty margins"),
        ("Q05", "DX017", 950501, "黑色单条水平锯齿带", "a black geometric zigzag band", "ivory", "#17191D", "#F5F0E6", "dark", 140, [0, 0.80, 1, 0.98], "horizontal-band", "one horizontal repeating band, empty space above and below"),
        ("Q06", "DX023", 960601, "粉色中心团花", "a single pink floral medallion", "ivory", "#D15D83", "#F5F0E6", "saturated", 80, [0, 0, 1, 1], "centered", "centered layered petals, empty margins"),
    ]
    tasks = []
    for identifier, pattern, seed, title, subject, background, foreground_hex, background_hex, mode, threshold, crop, layout, composition in specifications:
        tasks.append({
            "id": identifier, "patternId": pattern, "seed": seed, "title": title,
            "subject": subject, "background": background, "composition": composition,
            "evaluationTargetEnglish": f"{subject.capitalize()} on plain {background} fabric, {composition}, raised embroidery stitches and visible threads.",
            "evaluationTargetChinese": title + "，遵循参考主体形状和布局，保留空白边缘，具有可见针线和织物质感。",
            "preparation": {"pattern_id": pattern, "crop": crop, "mask_mode": mode, "threshold": threshold,
                            "palette_mode": "solid", "foreground_color": foreground_hex, "background_color": background_hex,
                            "layout": layout, "margin": 0.12, "width": 512, "height": 512, "texture_mode": "stitched"},
        })
    return {"schemaVersion": 1, "strength": 0.55, "controlScale": 0.8, "tasks": tasks,
            "flatReferenceOverride": {"texture_mode": "source"},
            "decisionRecord": "Root selected strength 0.55, ControlNet scale 0.8 and the recorded source-specific masks/palettes after 64 retained engineering exploration images. Four arms separate image reference, Canny structure, and stitched input material. Final reference previews are reviewed before freeze.",
            "explorationEvidence": []}


def validate_config(config):
    from reference_conditioning import _number, _settings

    if config.get("schemaVersion") != 1 or len(config.get("tasks", [])) != 6:
        raise ValueError("The design requires six tasks and schemaVersion 1")
    _number(config.get("strength"), "strength", 0.25, 0.85)
    _number(config.get("controlScale"), "controlScale", 0, 2)
    if not isinstance(config.get("decisionRecord"), str) or not config["decisionRecord"].strip():
        raise ValueError("Record the preprocessing and parameter decision before freezing")
    expected = draft_config()["tasks"]
    for task, original in zip(config["tasks"], expected):
        for field in ("id", "patternId", "seed"):
            if task.get(field) != original[field]:
                raise ValueError(f"The preselected task/seed changed at {original['id']}:{field}")
        for field in ("title", "subject", "background", "composition", "evaluationTargetEnglish", "evaluationTargetChinese"):
            if not isinstance(task.get(field), str) or not task[field].strip():
                raise ValueError(f"Missing task text {original['id']}:{field}")
        preparation = task["preparation"]
        if preparation.get("pattern_id") != task["patternId"] or any(key in preparation for key in ("element_id", "image_data_url")):
            raise ValueError("Use the preselected canonical pattern source")
        settings = _settings(preparation)
        if settings["palette_mode"] != "solid" or settings["width"] != 512 or settings["height"] != 512:
            raise ValueError("This color/shape design requires solid subject palettes on a 512-square canvas")
        if settings.get("texture_mode") != "stitched" or config.get("flatReferenceOverride") != {"texture_mode": "source"}:
            raise ValueError("I/R require stitched input and F requires the source-texture ablation")


def semantic_plan(task, embroidery_prompt):
    fields = [
        ("subject", "subject", task["subject"], 3),
        ("background", "palette", f"plain {task['background']} fabric background", 2),
        ("composition", "composition", task["composition"], 3),
        ("embroidery", "technique", embroidery_prompt, 2),
    ]
    return {"version": 1, "concepts": [
        {"id": f"{task['id']}:{name}", "dimension": dimension, "label": text, "promptText": text,
         "priority": priority, "enabled": True, "patternIds": [task["patternId"]], "sourceIds": [], "evidence": "user"}
        for name, dimension, text, priority in fields
    ], "extraPrompt": ""}


def local_api(base_url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return lambda endpoint, payload=None: runner.request_json(opener, base_url, endpoint, payload)


def same_text_conditioning(preview, expected, plan):
    for field in ("prompt", "negative_prompt", "semantic_plan", "generation_profile", "compiler_version", "applied_concept_ids"):
        if preview.get(field) != expected.get(field):
            raise ValueError(f"The four arms differ in text conditioning at {field}")
    policy = {key: value for key, value in preview.get("generation_policy", {}).items()
              if key not in ("spatial_control", "reference_preprocessor")}
    expected_policy = {key: value for key, value in expected.get("generation_policy", {}).items()
                       if key not in ("spatial_control", "reference_preprocessor")}
    if policy != expected_policy:
        raise ValueError("The four arms differ in their text-conditioning policy")
    if preview.get("semantic_plan") != plan or preview.get("omitted_concept_ids"):
        raise ValueError("A task condition changed or was omitted")
    if preview.get("prompt_token_count") is None or preview["prompt_token_count"] > 77:
        raise ValueError("The exact positive token budget could not be verified")
    if preview.get("generation_policy", {}).get("negative_token_count", 78) > 77:
        raise ValueError("Negative conditioning exceeds the token budget")
    if preview.get("texture_prompt"):
        raise ValueError("A reference-only texture suffix would confound the comparison")


def verify_reference_artifacts(output, tasks):
    for task in tasks:
        for reference in task["references"].values():
            for artifact in reference["artifacts"].values():
                if runner.file_hash(output / artifact["path"]) != artifact["sha256"]:
                    raise ValueError(f"Prepared reference changed {artifact['path']}")
        flat, stitched = task["references"]["source"], task["references"]["stitched"]
        for name in ("source.png", "mask.png", "control.png"):
            if flat["artifacts"][name]["sha256"] != stitched["artifacts"][name]["sha256"]:
                raise ValueError(f"The material ablation changed {task['id']} {name}")
        if flat["artifacts"]["init.png"]["sha256"] == stitched["artifacts"]["init.png"]["sha256"]:
            raise ValueError(f"The material ablation has identical initialization pixels for {task['id']}")


def prepare_inputs(output, config):
    from reference_conditioning import ARTIFACT_NAMES, CONTROL_ROOT, PREPROCESSOR_VERSION, prepare_reference

    validate_config(config)
    path = output / "preparation.json"
    if path.exists():
        preparation = runner.read_json(path)
        if preparation["config"] != config:
            raise ValueError("Reviewed configuration differs from existing reference preparation")
        for name, digest in preparation["sourceHashes"].items():
            if runner.file_hash(ROOT / name) != digest:
                raise ValueError(f"Reference preprocessor changed since review {name}")
        verify_reference_artifacts(output, preparation["tasks"])
        return preparation
    if (output / "manifest.json").exists() or (output / "references").exists():
        raise ValueError("The destination already contains a protocol or reference preparation")
    preparation = {"createdAt": runner.utc_now(), "config": deepcopy(config), "preprocessor": PREPROCESSOR_VERSION,
                   "sourceHashes": {name: runner.file_hash(ROOT / name) for name in ("reference_conditioning.py", "embroidery_material.py")},
                   "tasks": []}
    for task_config in config["tasks"]:
        task = deepcopy(task_config)
        task["seeds"] = [task["seed"] + offset for offset in range(3)]
        task["references"] = {}
        for texture in ("source", "stitched"):
            request = {**task["preparation"], "texture_mode": texture}
            reference = prepare_reference(request)
            reference_directory = CONTROL_ROOT / reference["reference_id"]
            destination = output / "references" / task["id"] / texture
            destination.mkdir(parents=True, exist_ok=False)
            for name in (*ARTIFACT_NAMES.values(), "metadata.json"):
                shutil.copy2(reference_directory / name, destination / name)
            task["references"][texture] = {key: value for key, value in reference.items() if not key.endswith("_image")}
            task["references"][texture]["artifacts"] = {
                name: {"path": (destination / name).relative_to(output).as_posix(), "sha256": runner.file_hash(destination / name)}
                for name in (*ARTIFACT_NAMES.values(), "metadata.json")}
            verify_empty_margin(destination / "mask.png", PIXEL_PROTOCOL)
        task["detailCrop"] = detail_crop(output / "references" / task["id"] / "source" / "mask.png")
        preparation["tasks"].append(task)
    verify_reference_artifacts(output, preparation["tasks"])
    runner.write_json(path, preparation)
    preparation_sheet(output, preparation["tasks"])
    print("Prepared six tasks with paired flat/stitched references and identical source, mask and control hashes", flush=True)
    return preparation


def preparation_sheet(output, tasks):
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    sheet = Image.new("RGB", (1312, 1854), "#f6f3ed")
    draw = ImageDraw.Draw(sheet)
    columns = [("source", "source.png", "规范原图"), ("source", "init.png", "平面配色输入"),
               ("stitched", "init.png", "针线材质输入"), ("source", "mask.png", "共享主体蒙版"),
               ("source", "control.png", "共享轮廓控制")]
    for column, (_, _, label) in enumerate(columns):
        draw.text((16 + column * 260, 12), label, font=font, fill="#202a32")
    for row, task in enumerate(tasks):
        y = 50 + row * 300
        draw.text((16, y), f"{task['id']} · {task['title']}", font=font, fill="#202a32")
        for column, (texture, filename, _) in enumerate(columns):
            with Image.open(output / "references" / task["id"] / texture / filename) as image:
                if image.mode == "RGBA":
                    matte = Image.new("RGBA", image.size, "#F5F0E6")
                    matte.alpha_composite(image)
                    image = matte.convert("RGB")
                sheet.paste(ImageOps.contain(image.convert("RGB"), (244, 244)), (16 + column * 260, y + 32))
    sheet.save(output / "reference-review.png")


def freeze(output, config, base_url):
    from reference_conditioning import PREPROCESSOR_VERSION

    if (output / "manifest.json").exists():
        raise ValueError("A frozen manifest already exists")
    preparation = prepare_inputs(output, config)
    api = local_api(base_url)
    health = api("/api/lora/health")
    if not health.get("reference_conditioning", {}).get("available"):
        raise ValueError("The local ControlNet model is unavailable")
    source_hashes = {name: runner.file_hash(ROOT / name) for name in SOURCE_FILES}
    embroidery_prompt = literal_constant("lora_service.py", "EMBROIDERY_PROMPT")
    environment = runner.environment_record(health)
    model_directory = Path(os.environ.get("XIUWEN_CONTROLNET_MODEL", str(ROOT / ".model-cache" / "control_v11p_sd15_canny")))
    for path in sorted(model_directory.iterdir()):
        if path.is_file() and path.suffix in (".json", ".safetensors"):
            environment["models"][f"controlnet:{path.name}"] = {"path": str(path), "sha256": runner.file_hash(path)}
    scorer_directory = ROOT / ".model-cache" / "clip-vit-base-patch32"
    scorer_files = {path.name: runner.file_hash(path) for path in sorted(scorer_directory.iterdir()) if path.is_file()}
    manifest = {
        "schemaVersion": 1, "experimentId": output.name, "createdAt": runner.utc_now(),
        "studyType": "known-source-new-task-reference-conditioning-comparison",
        "expectedCompiler": health["compiler_version"], "expectedPreprocessor": PREPROCESSOR_VERSION,
        "parameters": deepcopy(PARAMETERS), "methods": deepcopy(METHODS), "config": deepcopy(config),
        "embroideryPrompt": embroidery_prompt, "tasks": [], "jobs": [], "environment": environment,
        "provenance": {"sourceHashes": source_hashes, "scoringModelFiles": scorer_files},
        "evaluation": {
            "primaryComparison": "R-I", "materialAblationComparison": "R-F", "exploratoryComparisons": ["R-F", "I-T", "R-T", "F-T"],
            "primaryAutomaticMetric": "Foreground mask IoU using the frozen two-color Lab nearest-anchor segmentation against the prepared mask.",
            "secondaryMetrics": deepcopy(METRICS),
            "bootstrap": {"unit": "task after averaging all three fixed seeds", "resamples": 10000, "seed": 20261109},
            "scoringModel": {"name": "openai/clip-vit-base-patch32", "revision": "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"},
            "pixelProtocol": deepcopy(PIXEL_PROTOCOL),
            "interpretation": "Automatic structure and color proxies; texture, meaningful extra borders and cultural fidelity require real human assessment. CLIP is supplementary.",
        },
        "selectionPolicy": "Generate all 72 images using new predeclared seeds. Preserve every failure and output. Do not select candidates or tune settings after freezing.",
        "limitations": [
            "Reference source patterns are known development data. Newly fixed seeds and recoloring/cropping tasks do not establish held-out generalization.",
            "The six task intents share four source images. Butterfly and human-source pairs are related; task-level bootstrap intervals describe these fixed intents and do not imply six independent source patterns.",
            "I and R receive identical stitched reference pixels. R-I isolates adding Canny ControlNet to the shared image-to-image pipeline. F and R share source/mask/control hashes; R-F isolates the deterministic stitched input material.",
            "Text-to-image and image-to-image use different latent initialization and effective denoising schedules. Equal seeds pair labels, not identical starting latent tensors across T and I.",
            "Near-reference pixel scores can reward copying. Embroidery quality and newly introduced border semantics require viewing the untouched outputs and fixed-location detail crops.",
            "Foreground color assignment may be affected by shadows, highlights or texture. Report all task results and complementary background metrics.",
        ],
    }
    for prepared_task in preparation["tasks"]:
        task = deepcopy(prepared_task)
        task["semanticPlan"] = semantic_plan(task, embroidery_prompt)
        expected_preview = None
        for method in METHODS:
            payload = {**PARAMETERS, "seed": task["seed"], "pattern_id": task["patternId"], "pattern_name": task["title"],
                       "carrier": "固定参考对照二维纹样", "generation_profile": "subject-fidelity", "semantic_plan": deepcopy(task["semanticPlan"])}
            if method["id"] != "T":
                reference = task["references"]["source" if method["id"] == "F" else "stitched"]
                payload["reference_conditioning"] = {
                    "method": "img2img" if method["id"] == "I" else "canny-img2img",
                    "reference_id": reference["reference_id"], "reference_sha256": reference["reference_sha256"],
                    "strength": config["strength"], "control_scale": config["controlScale"], "embroidery_detail": False,
                }
            preview = api("/api/lora/preview", payload)
            if expected_preview is None:
                expected_preview = preview
            same_text_conditioning(preview, expected_preview, task["semanticPlan"])
            if preview.get("reference_conditioning") != payload.get("reference_conditioning"):
                raise ValueError("Reference preview differs from the requested method or parameters")
            spatial_control = "text-only" if method["id"] == "T" else payload["reference_conditioning"]["method"]
            if preview.get("generation_policy", {}).get("spatial_control") != spatial_control:
                raise ValueError("The preview policy does not record the actual spatial conditioning method")
            if method["id"] != "T" and preview["generation_policy"].get("reference_preprocessor") != PREPROCESSOR_VERSION:
                raise ValueError("The preview policy uses another reference preprocessor")
            manifest["jobs"].append({"id": f"{task['id']}-{method['id']}", "taskId": task["id"],
                                     "methodId": method["id"], "payload": payload, "preview": preview})
        manifest["tasks"].append(task)
    for relative, digest in source_hashes.items():
        if runner.file_hash(ROOT / relative) != digest:
            raise ValueError(f"Source changed while preparing protocol {relative}")
        destination = output / "source-snapshot" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)
    with (output / "manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    (output / "manifest.sha256").write_text(runner.file_hash(output / "manifest.json") + "  manifest.json\n", encoding="ascii")
    print("Frozen six tasks, 24 generation requests and 72 newly generated images", flush=True)


def validate_frozen(output, *, generation=False):
    manifest = runner.read_json(output / "manifest.json")
    digest = runner.file_hash(output / "manifest.json")
    if digest != (output / "manifest.sha256").read_text().split()[0]:
        raise ValueError("The frozen manifest changed")
    for relative, expected in manifest["provenance"]["sourceHashes"].items():
        if runner.file_hash(output / "source-snapshot" / relative) != expected:
            raise ValueError(f"Frozen source snapshot changed {relative}")
        if runner.file_hash(ROOT / relative) != expected:
            raise ValueError(f"Live generation or analysis source differs from the frozen version {relative}")
    verify_reference_artifacts(output, manifest["tasks"])
    for name, expected in manifest["provenance"]["scoringModelFiles"].items():
        if runner.file_hash(ROOT / ".model-cache" / "clip-vit-base-patch32" / name) != expected:
            raise ValueError(f"The frozen CLIP scoring model changed {name}")
    if generation:
        for model in manifest["environment"]["models"].values():
            if runner.file_hash(Path(model["path"])) != model["sha256"]:
                raise ValueError(f"Model file changed {model['path']}")
    return manifest, digest


def verify_record(record, job, task, manifest):
    runner.verify_generation(record, task, manifest["parameters"], job["preview"], manifest["expectedCompiler"])
    same_text_conditioning(record, job["preview"], task["semanticPlan"])
    if record.get("generation_policy") != job["preview"].get("generation_policy"):
        raise ValueError("Actual generation policy differs from this arm's frozen preview")
    if record.get("reference_conditioning") != job["payload"].get("reference_conditioning"):
        raise ValueError("Actual reference method/parameters differ from the frozen request")
    if job["methodId"] != "T":
        if record.get("reference_preparation") != job["preview"].get("reference_preparation"):
            raise ValueError("Actual prepared reference metadata changed")
        if record.get("postprocessing") != "none" or any(candidate.get("denoisingSteps", 0) < 1 for candidate in record["candidates"]):
            raise ValueError("Reference generation lacks denoising-step or raw-output evidence")
    if record.get("metadataSha256") and runner.file_hash(Path(record["metadata_path"])) != record["metadataSha256"]:
        raise ValueError("Original generation metadata changed")


def run_images(output, base_url, retry_failed):
    manifest, digest = validate_frozen(output, generation=True)
    api = local_api(base_url)
    health = api("/api/lora/health")
    if health.get("active_task") or health.get("queued_tasks"):
        raise ValueError("The shared inference service is busy")
    if health.get("compiler_version") != manifest["expectedCompiler"]:
        raise ValueError("The running compiler differs from the protocol")
    state_path = output / "state.json"
    state = runner.read_json(state_path) if state_path.exists() else {
        "manifestSha256": digest, "startedAt": runner.utc_now(), "jobs": {}, "attempts": [], "failures": {}}
    if state["manifestSha256"] != digest:
        raise ValueError("Checkpoint belongs to another protocol")
    tasks = {task["id"]: task for task in manifest["tasks"]}
    (output / "attempts").mkdir(exist_ok=True)
    for job in manifest["jobs"]:
        identifier = job["id"]
        if identifier in state["jobs"]:
            verify_record(state["jobs"][identifier]["generation"], job, tasks[job["taskId"]], manifest)
            continue
        if identifier in state["failures"] and not retry_failed:
            continue
        attempt = {"id": identifier, "stage": "generate", "status": "running", "startedAt": runner.utc_now(),
                   "payload": deepcopy(job["payload"])}
        state["attempts"].append(attempt)
        runner.write_json(state_path, state)
        started = time.monotonic()
        existing_runs = set((ROOT / "outputs" / "lora").glob("LORA-*/generation.json"))
        try:
            record = runner.stripped_generation(api("/api/lora/generate", job["payload"]))
            runner.write_json(output / "attempts" / f"{len(state['attempts']):02d}-{identifier}-response.json", record)
            verify_record(record, job, tasks[job["taskId"]], manifest)
            for candidate in record["candidates"]:
                candidate["sha256"] = runner.file_hash(Path(candidate["path"]))
            record["metadataSha256"] = runner.file_hash(Path(record["metadata_path"]))
            state["jobs"][identifier] = {"taskId": job["taskId"], "methodId": job["methodId"], "generation": record}
            state["failures"].pop(identifier, None)
            attempt["status"] = "complete"
            print(f"generated {identifier}, 3 images, {record['inference_seconds']} seconds", flush=True)
        except Exception as error:
            attempt.update(status="failed", error=str(error))
            state["failures"][identifier] = {"taskId": job["taskId"], "methodId": job["methodId"], "stage": "generate", "error": str(error)}
            # The service persists partial PNGs even when HTTP generation fails.
            # Link every matching new run so partial candidates remain auditable.
            attempt["partialRuns"] = []
            for metadata_path in sorted(set((ROOT / "outputs" / "lora").glob("LORA-*/generation.json")) - existing_runs):
                try:
                    metadata = runner.read_json(metadata_path)
                    if metadata.get("seed") == job["payload"]["seed"] and metadata.get("pattern_id") == job["payload"]["pattern_id"]:
                        attempt["partialRuns"].append({
                            "metadataPath": str(metadata_path), "metadataSha256": runner.file_hash(metadata_path),
                            "record": metadata,
                            "candidateFiles": [{"path": item["path"], "sha256": runner.file_hash(Path(item["path"]))}
                                               for item in metadata.get("candidates", []) if Path(item["path"]).is_file()],
                        })
                except (OSError, ValueError, KeyError) as capture_error:
                    attempt["partialRuns"].append({"metadataPath": str(metadata_path), "captureError": str(capture_error)})
            print(f"failed {identifier} {error}", flush=True)
        finally:
            attempt.update(endedAt=runner.utc_now(), elapsedSeconds=round(time.monotonic() - started, 4))
            runner.write_json(output / "attempts" / f"{len(state['attempts']):02d}-{identifier}-attempt.json", attempt)
            runner.write_json(state_path, state)
    state.update(finishedAt=runner.utc_now(), status="complete" if len(state["jobs"]) == len(manifest["jobs"]) else "partial")
    runner.write_json(state_path, state)


def margin_region(shape, fraction):
    import numpy as np

    height, width = shape
    band = max(1, round(min(height, width) * fraction))
    region = np.ones(shape, dtype=bool)
    region[band:-band, band:-band] = False
    return region


def verify_empty_margin(mask_path, protocol):
    import numpy as np
    from PIL import Image

    with Image.open(mask_path) as image:
        mask = np.asarray(image.convert("L")) >= protocol["maskThreshold"]
    margin = margin_region(mask.shape, protocol["marginFraction"])
    if mask[margin].any():
        raise ValueError("The prepared subject occupies the predeclared blank outer-margin evaluation region")


def detail_crop(mask_path):
    import cv2
    import numpy as np
    from PIL import Image

    with Image.open(mask_path) as image:
        mask = (np.asarray(image.convert("L")) >= 128).astype(np.uint8)
    y, x = np.unravel_index(np.argmax(cv2.distanceTransform(mask, cv2.DIST_L2, 5)), mask.shape)
    left, top = min(max(int(x) - 64, 0), mask.shape[1] - 128), min(max(int(y) - 64, 0), mask.shape[0] - 128)
    return [left, top, left + 128, top + 128]


def pixel_metrics(image, reference_mask, task, protocol):
    import cv2
    import numpy as np

    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    smooth = cv2.GaussianBlur(rgb, (0, 0), protocol["segmentationBlurSigma"])
    lab = cv2.cvtColor(smooth, cv2.COLOR_RGB2LAB)
    colors = [task["preparation"][key] for key in ("foreground_color", "background_color")]
    anchor_rgb = np.array([[int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)] for color in colors], dtype=np.float32)
    anchors = cv2.cvtColor(anchor_rgb.reshape(1, 2, 3), cv2.COLOR_RGB2LAB)[0]
    foreground_distance = np.linalg.norm(lab - anchors[0], axis=2)
    background_distance = np.linalg.norm(lab - anchors[1], axis=2)
    predicted = foreground_distance < background_distance
    expected = np.asarray(reference_mask.convert("L")) >= protocol["maskThreshold"]
    union = int(np.count_nonzero(predicted | expected))
    intersection = int(np.count_nonzero(predicted & expected))
    predicted_edges = cv2.Canny(predicted.astype(np.uint8) * 255, 80, 160) > 0
    expected_edges = cv2.Canny(expected.astype(np.uint8) * 255, 80, 160) > 0
    tolerance = protocol["boundaryTolerancePixels"]
    kernel = np.ones((2 * tolerance + 1, 2 * tolerance + 1), dtype=np.uint8)
    expected_nearby = cv2.dilate(expected_edges.astype(np.uint8), kernel) > 0
    predicted_nearby = cv2.dilate(predicted_edges.astype(np.uint8), kernel) > 0
    precision = float((predicted_edges & expected_nearby).sum() / max(1, predicted_edges.sum()))
    recall = float((expected_edges & predicted_nearby).sum() / max(1, expected_edges.sum()))
    erosion = protocol["foregroundErosionPixels"]
    foreground_region = cv2.erode(expected.astype(np.uint8), np.ones((2 * erosion + 1, 2 * erosion + 1), dtype=np.uint8)) > 0
    exclusion = protocol["backgroundExclusionPixels"]
    background_region = cv2.dilate(expected.astype(np.uint8), np.ones((2 * exclusion + 1, 2 * exclusion + 1), dtype=np.uint8)) == 0
    if not foreground_region.any() or not background_region.any():
        raise ValueError("The frozen mask lacks a measurable foreground/background region")
    margin = margin_region(expected.shape, protocol["marginFraction"])
    blurred = cv2.GaussianBlur((rgb * 255).astype(np.uint8), (0, 0), protocol["marginEdgeBlurSigma"])
    edges = cv2.Canny(cv2.cvtColor(blurred, cv2.COLOR_RGB2GRAY), *protocol["marginCannyThresholds"]) > 0
    return {
        "maskIoU": intersection / max(1, union),
        "boundaryF1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "boundaryPrecision": precision, "boundaryRecall": recall,
        "foregroundDeltaE76": float(foreground_distance[foreground_region].mean()),
        "backgroundDeltaE76": float(background_distance[background_region].mean()),
        "marginForegroundRate": float(predicted[margin].mean()),
        "marginEdgeDensity": float(edges[margin].mean()),
        "foregroundAreaFraction": float(predicted.mean()), "referenceForegroundAreaFraction": float(expected.mean()),
    }


def quantitative_summary(samples, manifest):
    import numpy as np

    task_means = []
    for task in manifest["tasks"]:
        for method in METHODS:
            rows = [sample for sample in samples if sample["taskId"] == task["id"] and sample["methodId"] == method["id"]]
            complete = sorted(row["seed"] for row in rows) == task["seeds"]
            task_means.append({"taskId": task["id"], "methodId": method["id"], "images": len(rows), "complete": complete,
                               "metrics": {key: float(np.mean([row[key] for row in rows])) if rows else None for key in METRICS}})
    bootstrap = manifest["evaluation"]["bootstrap"]
    methods = []
    for method in METHODS:
        rows = [row for row in task_means if row["methodId"] == method["id"] and row["complete"]]
        methods.append({**method, "completeTasks": len(rows), "images": sum(sample["methodId"] == method["id"] for sample in samples),
                        "metrics": {key: analysis.interval([row["metrics"][key] for row in rows], bootstrap["resamples"], bootstrap["seed"]) for key in METRICS}})
    contrasts = []
    for comparison in (manifest["evaluation"]["primaryComparison"], *manifest["evaluation"]["exploratoryComparisons"]):
        first, second = comparison.split("-")
        pairs = []
        for task in manifest["tasks"]:
            rows = {row["methodId"]: row for row in task_means if row["taskId"] == task["id"] and row["complete"]}
            if first in rows and second in rows:
                pairs.append({"taskId": task["id"], "metrics": {key: rows[first]["metrics"][key] - rows[second]["metrics"][key] for key in METRICS}})
        contrasts.append({"comparison": comparison, "primary": comparison == "R-I", "pairedTaskDifferences": pairs,
                          "excludedTaskIds": [task["id"] for task in manifest["tasks"] if task["id"] not in {pair["taskId"] for pair in pairs}],
                          "metrics": {key: analysis.interval([pair["metrics"][key] for pair in pairs], bootstrap["resamples"], bootstrap["seed"]) for key in METRICS}})
    return {"methods": methods, "taskMeans": task_means, "contrasts": contrasts}


def make_contact_sheets(output, manifest, samples):
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = ImageFont.truetype(str(font_path), 18) if font_path.exists() else ImageFont.load_default()
    directory = output / "contact-sheets"
    directory.mkdir(exist_ok=True)
    for task in manifest["tasks"]:
        sheet = Image.new("RGB", (1348, 1420), "#f6f3ed")
        draw = ImageDraw.Draw(sheet)
        draw.text((22, 14), f"{task['id']} · {task['title']} · 全部固定种子", font=font, fill="#202a32")
        references = (("source", "init.png", "F平面参考"), ("stitched", "init.png", "I/R针线参考"),
                      ("source", "mask.png", "共享主体蒙版"), ("source", "control.png", "F/R结构控制"))
        for column, (texture, filename, label) in enumerate(references):
            x = 22 + 332 * column
            draw.text((x, 48), label, font=font, fill="#202a32")
            with Image.open(output / "references" / task["id"] / texture / filename) as image:
                sheet.paste(ImageOps.contain(image.convert("RGB"), (304, 304)), (x, 80))
        for column, method in enumerate(METHODS):
            x = 22 + 332 * column
            draw.text((x, 402), f"{method['id']} · {method['label']}", font=font, fill="#202a32")
            for row, seed in enumerate(task["seeds"]):
                y = 438 + row * 318
                sample = next((item for item in samples if item["taskId"] == task["id"] and item["methodId"] == method["id"] and item["seed"] == seed), None)
                if sample:
                    with Image.open(sample["path"]) as image:
                        sheet.paste(ImageOps.contain(image.convert("RGB"), (284, 284)), (x, y))
                    draw.text((x, y + 286), f"{seed} · IoU {sample['maskIoU']:.3f}", font=font, fill="#485259")
                else:
                    draw.text((x, y + 110), f"{seed} · 未完成", font=font, fill="#9b392c")
        sheet.save(directory / f"{task['id']}.png")


def render_report(output, manifest, summary):
    method_rows = []
    for method in summary["methods"]:
        values = [f"{method['id']} · {method['label']}", f"{method['images']}/18"]
        values.extend(f"{method['metrics'][key]['mean']:.4f}" if method["metrics"][key] else "未完成" for key in METRICS)
        method_rows.append("<tr>" + "".join(f"<td>{html.escape(value)}</td>" for value in values) + "</tr>")
    contrast_rows = []
    for contrast in summary["contrasts"]:
        for key, description in METRICS.items():
            result = contrast["metrics"][key]
            if result:
                contrast_rows.append(f"<tr><td>{contrast['comparison']}</td><td>{description['label']}</td><td>{result['tasks']}</td><td>{result['mean']:+.4f}</td><td>[{result['ci95'][0]:+.4f}, {result['ci95'][1]:+.4f}]</td></tr>")
    figures = []
    for task in manifest["tasks"]:
        details = []
        for sample in summary["samples"]:
            if sample["taskId"] == task["id"]:
                details.append(f'<figure><a href="{sample["image"]}"><img loading="lazy" src="{sample["detailImage"]}" alt="{sample["id"]}原始局部"></a><figcaption>{sample["methodId"]} · {sample["seed"]}</figcaption></figure>')
        figures.append(f'<section><h2>{task["id"]} · {html.escape(task["title"])}</h2><p>{html.escape(task["evaluationTargetChinese"])}</p><img class="sheet" loading="lazy" src="contact-sheets/{task["id"]}.png" alt="全部候选及参考输入"><details><summary>同一预定位置的128像素原始细节，点击查看完整原图</summary><div class="details">{"".join(details)}</div></details></section>')
    failures = "".join(f"<li>{html.escape(identifier)} · {html.escape(item['error'])}</li>" for identifier, item in summary["failures"].items())
    failure_section = f'<section class="failure"><h2>未完成任务</h2><ul>{failures}</ul><p>完整配对统计排除未完成任务，缺失可能与方法有关，区间存在选择偏倚。</p></section>' if failures else ""
    headers = "".join(f"<th>{item['label']}{'↑' if item['higherIsBetter'] else '↓'}</th>" for item in METRICS.values())
    page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>结构与配色参考验证</title>
<style>body{{margin:0;background:#f6f3ed;color:#202a32;font:16px/1.65 system-ui,sans-serif}}main{{max-width:1180px;margin:auto;padding:24px}}h1{{font-size:28px}}h2{{font-size:22px}}.scroll{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{text-align:left;border-bottom:1px solid #c4c9c6;padding:8px;white-space:nowrap}}.sheet{{max-width:100%;height:auto}}section{{margin:30px 0}}.details{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}}figure{{margin:12px 0}}figure img{{width:100%;max-width:256px}}a{{color:#24645d}}li{{overflow-wrap:anywhere}}.failure{{border-left:4px solid #a04032;padding-left:16px}}@media(max-width:600px){{main{{padding:14px}}.details{{grid-template-columns:repeat(2,minmax(0,1fr))}}}}</style></head><body><main>
<h1>结构与配色参考验证</h1><p>六个固定任务，各三个新种子，四组计划72张，实际完成 {summary['completedImages']}/72 张。全部组使用相同语义方案、实际正负提示词、SD1.5、LoRA 0.35、512²、30步和CFG 7.2。统一刺绣描述包含在各组画布中。</p>
<p>I与R增加经冻结裁切、主体蒙版、重新配色及程序化针线材质处理的同一参考像素。R在相同图生图条件上增加Canny ControlNet，主要比较为R−I。F采用平面输入与相同轮廓控制，R−F用于检查针线输入材质贡献。两套参考的原始来源、主体蒙版、控制图哈希相同，初始化图像不同。图生图去噪强度为 {manifest['config']['strength']}，控制强度为 {manifest['config']['controlScale']}。参考生成的实际有效采样步数按候选保存。</p>
<p>规范原图已用于项目开发，本次使用新种子和明确重配色意图。六个意图共享四张来源图，蝴蝶及人形来源的成对任务具有相关性，任务级区间用于描述当前固定意图。轮廓、区域配色及空白边缘指标衡量输入约束的保持。CLIP作为补充。针线质感、额外外框含义与审美由原图和局部图供人工核对，真人评分当前为空。</p>
{failure_section}<h2>全任务汇总</h2><div class="scroll"><table><thead><tr><th>方法</th><th>完成图像</th>{headers}</tr></thead><tbody>{''.join(method_rows)}</tbody></table></div>
<h2>配对差值</h2><p>每任务平均三个种子，以完整配对任务为单位重采样10000次，固定随机种子20261109。区间为描述性95%百分位区间。色差和空白边缘指标越低越好。主要终点为R−I的主体区域IoU，其余指标用于补充核对。</p><div class="scroll"><table><thead><tr><th>比较</th><th>指标</th><th>完整任务数</th><th>平均差</th><th>95%区间</th></tr></thead><tbody>{''.join(contrast_rows)}</tbody></table></div>
<p>主体区域由固定前景／背景颜色的Lab最近锚点判别，阴影和针线高光可能影响分割。低频边缘指标也会响应织物变化。高参考相似度可能来自对参考图的复制，需要结合纹理与细节观察。</p>
<p><a href="manifest.json">冻结方案</a> · <a href="summary.json">逐图数据与统计</a> · <a href="state.json">请求和失败记录</a></p>{''.join(figures)}</main></body></html>'''
    (output / "index.html").write_text(page, encoding="utf-8")


def analyze(output):
    from PIL import Image

    manifest, digest = validate_frozen(output)
    state = runner.read_json(output / "state.json")
    if state["manifestSha256"] != digest:
        raise ValueError("Checkpoint protocol mismatch")
    tasks = {task["id"]: task for task in manifest["tasks"]}
    jobs = {job["id"]: job for job in manifest["jobs"]}
    samples = []
    for identifier, job in state["jobs"].items():
        task = tasks[job["taskId"]]
        verify_record(job["generation"], jobs[identifier], task, manifest)
        for candidate in job["generation"]["candidates"]:
            source = Path(candidate["path"])
            destination = output / "images" / job["methodId"] / f"{task['id']}-{candidate['seed']}.png"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            detail = output / "details" / job["methodId"] / destination.name
            detail.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(source) as image, Image.open(output / "references" / task["id"] / "source" / "mask.png") as mask:
                metrics = pixel_metrics(image, mask, task, manifest["evaluation"]["pixelProtocol"])
                image.crop(tuple(task["detailCrop"])).save(detail)
            samples.append({"id": f"{identifier}-{candidate['seed']}", "taskId": task["id"], "methodId": job["methodId"],
                            "seed": candidate["seed"], "path": str(destination), "originalPath": str(source),
                            "image": destination.relative_to(output).as_posix(), "detailImage": detail.relative_to(output).as_posix(),
                            "detailCrop": task["detailCrop"], "sha256": candidate["sha256"],
                            "configuredInferenceSteps": manifest["parameters"]["steps"],
                            "observedDenoisingSteps": candidate.get("denoisingSteps"), **metrics})
    scorer = analysis.score_images(samples, manifest, ROOT / ".model-cache" / "clip-vit-base-patch32") if samples else None
    summary = {"schemaVersion": 1, "createdAt": runner.utc_now(), "manifestSha256": digest,
               "plannedImages": 72, "completedImages": len(samples), "plannedJobs": 24, "completedJobs": len(state["jobs"]),
               "generationAttempts": len(state["attempts"]), "failedAttempts": sum(item["status"] == "failed" for item in state["attempts"]),
               "evaluation": manifest["evaluation"], "scorer": scorer,
               "pixelScorer": {"opencv": __import__("cv2").__version__, "numpy": __import__("numpy").__version__,
                               "pillow": __import__("PIL").__version__},
               "samples": samples, "failures": state["failures"],
               "humanRatingsCollected": 0, "humanRatings": [], "limitations": manifest["limitations"],
               **quantitative_summary(samples, manifest)}
    if state["failures"]:
        summary["limitations"].append("Complete-case comparisons exclude incomplete tasks. Method-dependent failures can bias these comparisons.")
    runner.write_json(output / "summary.json", summary)
    make_contact_sheets(output, manifest, samples)
    render_report(output, manifest, summary)
    print(json.dumps({"images": len(samples), "contrasts": [{"comparison": row["comparison"], "maskIoU": row["metrics"]["maskIoU"]} for row in summary["contrasts"]]}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("draft", "check", "prepare", "freeze", "generate", "analyze"))
    parser.add_argument("--config", type=Path, help="Reviewed task preprocessing and common inference parameters")
    parser.add_argument("--output", type=Path, default=ROOT / "outputs" / "reference-control-validation-2026-11-09")
    parser.add_argument("--base-url", default="http://127.0.0.1:8001")
    parser.add_argument("--retry-failed", action="store_true", help="Explicitly retry failed batches while retaining every prior attempt")
    arguments = parser.parse_args()
    config = runner.read_json(arguments.config) if arguments.config else draft_config()
    if arguments.stage in ("draft", "check"):
        validate_config(config)
        content = config if arguments.stage == "draft" else {"tasks": len(config["tasks"]), "methods": len(METHODS), "newImages": 72,
                                                               "embroideryPrompt": literal_constant("lora_service.py", "EMBROIDERY_PROMPT")}
        print(json.dumps(content, ensure_ascii=False, indent=2))
        return
    if arguments.stage == "freeze" and arguments.config is None:
        parser.error("freeze requires --config with the reviewed preprocessing and parameters")
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    lock = output / ".validation.lock"
    with lock.open("x", encoding="utf-8") as stream:
        stream.write(runner.utc_now())
    try:
        if arguments.stage == "prepare":
            prepare_inputs(output, config)
        elif arguments.stage == "freeze":
            freeze(output, config, arguments.base_url)
        elif arguments.stage == "generate":
            run_images(output, arguments.base_url, arguments.retry_failed)
        else:
            analyze(output)
    finally:
        lock.unlink()


if __name__ == "__main__":
    main()

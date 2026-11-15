"""Exercise two real reference images through the local TOBEST HTTP endpoint.

Run after the shared GPU is idle. Technical checks are recorded separately from
visual review notes, and every run retains its original responses and errors.
"""

import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time

import requests


ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = ROOT / "纹样库" / "侗族" / "_标注成果"
OUTPUT_ROOT = ROOT / "outputs" / "reproduction-2026-11-09"
REPORT_PATH = OUTPUT_ROOT / "reference-verification.json"
ENDPOINT = "http://127.0.0.1:8001/api/lora"
PATTERN_IDS = ("DX027", "DX017")
TOBEST_FIELDS = ("theme", "object", "background", "emotion", "style", "technique")
REFERENCE_REVIEW = {
    "DX027": [
        "图像显示左右近似对称的卷曲翼状纹样，左侧为红色，右侧接近蓝绿色。",
        "中央上下轴线清晰，背景为米白圆形区域，纹样表面可见细小纹理。",
        "规范标注命名为蝴蝶花纹，纯视觉识别仍需容许抽象轮廓带来的主体歧义。",
    ],
    "DX017": [
        "上方横排三个黑色几何人形，菱形头部、连臂动作和分开的腿部可见。",
        "背景为米白色，下方有独立的重复几何边饰。",
        "主体数量、横向排列及人形与下方边饰的区分可用于逐项核对输出。",
    ],
}


def save_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def technical_errors(response: object, digest: str) -> list[str]:
    errors = []
    if not isinstance(response, dict):
        return ["HTTP response is not a JSON object"]
    if response.get("observation_schema") != "dong-tobest-1":
        errors.append("Observation schema differs from dong-tobest-1")
    reference = response.get("reference", {})
    if not isinstance(reference, dict):
        reference = {}
    if reference.get("sha256") != digest or reference.get("id") != f"REF-{digest[:16]}":
        errors.append("Reference digest or identifier does not match the submitted image")
    fields = response.get("tobest_observations")
    if not isinstance(fields, dict) or set(fields) != set(TOBEST_FIELDS):
        errors.append("Normalized observations must contain all six TOBEST fields")
        fields = {}
    plan = response.get("semantic_plan", {})
    concepts = plan.get("concepts", []) if isinstance(plan, dict) else []
    if not isinstance(concepts, list) or not all(isinstance(item, dict) for item in concepts):
        return [*errors, "Semantic concepts are malformed"]
    identifiers = [item.get("id") for item in concepts]
    by_id = {item["id"]: item for item in concepts if isinstance(item.get("id"), str)}
    if len(by_id) != len(concepts) or not all(isinstance(value, str) and value.startswith(f"vision:REF-{digest[:16]}:") for value in identifiers):
        errors.append("Observation concept identifiers are duplicated or detached from the reference")
    if not any(item.get("dimension") == "subject" and item.get("enabled") is True for item in concepts):
        errors.append("The response has no enabled subject observation")
    objects = fields.get("object", [])
    if not objects:
        errors.append("Normalized object observations are empty")
    for field in TOBEST_FIELDS:
        items = fields.get(field, [])
        if not isinstance(items, list):
            errors.append(f"Normalized {field} observations are not a list")
            continue
        for item in items:
            if not isinstance(item, dict):
                errors.append(f"Normalized {field} observation is malformed")
                continue
            concept = by_id.get(item.get("concept_id"))
            if concept is None:
                errors.append(f"Normalized {field} observation has no matching concept")
                continue
            if field == "object" and concept.get("dimension") != "subject":
                errors.append("Object observation was not mapped to subject")
            if field == "background" and concept.get("dimension") != "composition":
                errors.append("Background observation was not mapped to composition")
            if field in {"theme", "emotion"}:
                if concept.get("dimension") != "intention" or concept.get("enabled") is not False or item.get("enabled") is not False:
                    errors.append(f"Suggested {field} must be an initially disabled intention")
    for concept in concepts:
        if concept.get("evidence") != "user" or concept.get("sourceIds") != [] or concept.get("patternIds") != []:
            errors.append("A model observation acquired unsupported source evidence")
    return errors


def main() -> int:
    patterns = json.loads((DATA_ROOT / "03_标注数据" / "patterns.json").read_text(encoding="utf-8-sig"))
    selected = {pattern["id"]: pattern for pattern in patterns if pattern["id"] in PATTERN_IDS}
    if set(selected) != set(PATTERN_IDS):
        raise RuntimeError("Canonical reference patterns are missing")
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8")) if REPORT_PATH.exists() else {
        "type": "real-local-tobest-reference-verification", "report_version": 1, "runs": [],
        "interpretation": "Endpoint and schema checks measure technical behavior. Visual notes are assistant observations; no user or expert ratings are collected.",
    }
    now = datetime.now(timezone.utc)
    run_id = now.strftime("%Y%m%dT%H%M%S%fZ")
    run = {
        "id": run_id, "started_at": now.isoformat(), "status": "running",
        "endpoint": ENDPOINT + "/analyze-reference", "pattern_ids": list(PATTERN_IDS),
        "local_vision_source_sha256": hashlib.sha256((ROOT / "local_vision.py").read_bytes()).hexdigest(),
        "samples": [],
    }
    report["runs"].append(run)
    save_json(REPORT_PATH, report)
    session = requests.Session()
    session.trust_env = False
    try:
        health = session.get(ENDPOINT + "/health", timeout=(5, 10))
        health.raise_for_status()
        run["health_before"] = health.json()
        if not isinstance(run["health_before"], dict):
            raise ValueError("Local health response is malformed")
        if run["health_before"].get("active_task") or run["health_before"].get("queued_tasks"):
            raise RuntimeError("The shared local model queue is busy; resume after the GPU owner releases it")
    except (requests.RequestException, ValueError, RuntimeError) as error:
        run["status"] = "blocked_before_inference"
        run["error"] = str(error)
        save_json(REPORT_PATH, report)
        print(run["error"], flush=True)
        return 1
    for pattern_id in PATTERN_IDS:
        pattern = selected[pattern_id]
        image_path = (DATA_ROOT / pattern["image"]).resolve()
        if not image_path.is_relative_to(DATA_ROOT.resolve()):
            raise RuntimeError("Canonical reference path is outside its data directory")
        image_bytes = image_path.read_bytes()
        digest = hashlib.sha256(image_bytes).hexdigest()
        directory = OUTPUT_ROOT / "reference-runs" / run_id / pattern_id
        directory.mkdir(parents=True, exist_ok=True)
        snapshot = directory / "reference-input.png"
        snapshot.write_bytes(image_bytes)
        sample = {
            "pattern_id": pattern_id, "canonical_source": str(image_path), "source_sha256": digest,
            "source_snapshot": str(snapshot.relative_to(OUTPUT_ROOT)),
            "canonical_visual_description": pattern["visual_description"],
            "quality_review": {"reviewer": "assistant_visual_review", "status": "pending_output_inspection",
                               "reference_observations": REFERENCE_REVIEW[pattern_id], "output_observations": []},
        }
        run["samples"].append(sample)
        started = time.perf_counter()
        try:
            response = session.post(ENDPOINT + "/analyze-reference", json={
                "image_data_url": "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii"),
            }, timeout=(10, 210))
            sample["http_status"] = response.status_code
            sample["client_elapsed_seconds"] = round(time.perf_counter() - started, 3)
            try:
                payload = response.json()
            except ValueError:
                payload = {"unparsed_http_body": response.text}
            save_json(directory / "response.json", payload)
            sample["response_path"] = str((directory / "response.json").relative_to(OUTPUT_ROOT))
            response.raise_for_status()
            errors = technical_errors(payload, digest)
            sample["technical_status"] = "failed" if errors else "passed"
            sample["technical_errors"] = errors
            payload = payload if isinstance(payload, dict) else {}
            save_json(directory / "parsed-observations.json", {
                "observation_schema": payload.get("observation_schema"),
                "tobest_observations": payload.get("tobest_observations"),
                "visual_extensions": payload.get("visual_extensions"),
                "semantic_plan": payload.get("semantic_plan"),
            })
            raw = payload.get("raw_observation")
            if isinstance(raw, str):
                (directory / "raw-observation.txt").write_text(raw, encoding="utf-8")
        except (requests.RequestException, ValueError) as error:
            sample["client_elapsed_seconds"] = round(time.perf_counter() - started, 3)
            sample["technical_status"] = "failed"
            sample["error"] = str(error)
        save_json(REPORT_PATH, report)
        print(f'{pattern_id}: {sample["technical_status"]}, {sample["client_elapsed_seconds"]}s', flush=True)
    run["status"] = "passed" if all(sample["technical_status"] == "passed" for sample in run["samples"]) else "failed"
    run["finished_at"] = datetime.now(timezone.utc).isoformat()
    save_json(REPORT_PATH, report)
    print(f"Saved {REPORT_PATH}", flush=True)
    return 0 if run["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())

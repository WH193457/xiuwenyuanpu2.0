"""Run the frozen local PromptTCP ablation through the normal HTTP service.

Every attempt and checkpoint is recorded. Repeating this command resumes only
complete, hash-verified jobs belonging to the same manifest and code version.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import sys
import time
from typing import Any
import urllib.error
import urllib.request

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def environment_record(health: dict) -> dict:
    from local_language import MODEL_NAME, MODEL_PATH

    model_files = {"base": Path(health["base_model"]), "lora": Path(health["lora_weights"])}
    for path in sorted(MODEL_PATH.iterdir()):
        if path.is_file() and (path.suffix in {".json", ".safetensors"} or path.name == "merges.txt"):
            model_files[f"language:{path.name}"] = path
    versions = {}
    for name in ("torch", "diffusers", "transformers", "safetensors", "xformers"):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    cache_roots = {PROJECT_ROOT.parent / "lora-scripts-main" / "huggingface", Path.home() / ".cache" / "huggingface"}
    if os.environ.get("HF_HOME"):
        cache_roots.add(Path(os.environ["HF_HOME"]))
    schedulers = []
    for cache in sorted(cache_roots):
        for path in sorted(cache.glob("hub/models--stable-diffusion-v1-5--stable-diffusion-v1-5/snapshots/*/scheduler/scheduler_config.json")):
            schedulers.append({"path": str(path), "sha256": file_hash(path), "config": read_json(path)})
    return {
        "python": sys.version, "platform": platform.platform(), "health": health, "libraries": versions,
        "models": {name: {"path": str(path), "sha256": file_hash(path)} for name, path in model_files.items()},
        "languageModel": {"name": MODEL_NAME, "directory": str(MODEL_PATH), "snapshotDirectory": MODEL_PATH.name,
                          "resolution": "local_language.MODEL_PATH in the experiment runner environment"},
        "cachedSchedulers": schedulers,
        "schedulerEvidence": "Available local SD1.5 cache configuration; inferred candidate configurations, not an observation of the service's loaded scheduler instance.",
    }


def request_json(opener: Any, base_url: str, endpoint: str, payload: dict | None = None) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(base_url + endpoint, data=body, headers={"Content-Type": "application/json"})
    try:
        with opener.open(request, timeout=600) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} {endpoint} {detail[:3000]}") from error
    if not isinstance(result, dict):
        raise ValueError(f"Unexpected response from {endpoint}")
    return result


def stripped_generation(response: dict) -> dict:
    # Preserve the complete textual audit trail without redundant base64 blobs.
    result = {key: value for key, value in response.items() if key != "image_data_url"}
    result["candidates"] = [{key: value for key, value in candidate.items() if key != "image"}
                            for candidate in response.get("candidates", [])]
    return result


def verify_generation(record: dict, task: dict, parameters: dict, preview: dict, compiler: str) -> None:
    if record.get("status") != "complete" or record.get("compiler_version") != compiler:
        raise ValueError("Generation status/compiler differs from the frozen protocol")
    if record.get("prompt") != preview.get("prompt"):
        raise ValueError("Actual generation prompt differs from the recorded preview")
    if record.get("negative_prompt") != preview.get("negative_prompt"):
        raise ValueError("Actual negative prompt differs from the recorded preview")
    for key, value in parameters.items():
        if record.get(key) != value:
            raise ValueError(f"Generation parameter mismatch for {key}")
    candidates = record.get("candidates", [])
    if len(candidates) != len(task["seeds"]) or [item.get("seed") for item in candidates] != task["seeds"]:
        raise ValueError("Generation candidate count or seeds differ from the protocol")
    for candidate in candidates:
        path = Path(candidate["path"])
        if not path.is_file():
            raise ValueError(f"Missing candidate image {path}")
        if candidate.get("sha256") and file_hash(path) != candidate["sha256"]:
            raise ValueError(f"Candidate image has changed {path}")


def execute(args: argparse.Namespace) -> int:
    output = args.output.resolve()
    manifest_path = output / "manifest.json"
    manifest = read_json(manifest_path)
    manifest_hash = file_hash(manifest_path)
    expected_hash = (output / "manifest.sha256").read_text(encoding="utf-8").split()[0]
    if manifest_hash != expected_hash:
        raise ValueError("Manifest checksum changed. Create a new experiment directory.")
    for relative_path, expected in manifest["provenance"]["sourceHashes"].items():
        if file_hash(PROJECT_ROOT / relative_path) != expected:
            raise ValueError(f"Source changed after protocol freeze: {relative_path}. Use a new experiment directory.")
        if file_hash(output / "source-snapshot" / relative_path) != expected:
            raise ValueError(f"Frozen source snapshot changed: {relative_path}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    health = request_json(opener, args.base_url, "/api/lora/health")
    if health.get("compiler_version") != manifest["expectedCompiler"]:
        raise ValueError("Restart the local service with the protocol's compiler version before running")
    if not health.get("runtime_available") or not health.get("language", {}).get("available"):
        raise ValueError("Local image and language models must both be available")
    if health.get("active_task") or health.get("queued_tasks"):
        raise ValueError("The shared GPU service is busy. Wait before starting this controlled run.")

    state_path = output / "experiment-state.json"
    if state_path.exists():
        state = read_json(state_path)
        if state.get("manifestSha256") != manifest_hash:
            raise ValueError("Checkpoint belongs to a different experiment manifest")
        for model in state["environment"]["models"].values():
            if file_hash(Path(model["path"])) != model["sha256"]:
                raise ValueError("Model weights changed after the experiment started")
    else:
        state = {"schemaVersion": 1, "manifestSha256": manifest_hash, "startedAt": utc_now(),
                 "environment": environment_record(health),
                 "preparations": {}, "jobs": {}, "attempts": []}
        write_json(state_path, state)

    def perform(stage: str, identifier: str, endpoint: str, payload: dict) -> dict:
        started = time.monotonic()
        attempt = {"stage": stage, "id": identifier, "endpoint": endpoint, "startedAt": utc_now(), "status": "running"}
        state["attempts"].append(attempt)
        write_json(state_path, state)
        try:
            response = request_json(opener, args.base_url, endpoint, payload)
            response_path = output / "attempts" / f"{len(state['attempts']):03d}-{stage}-{identifier}.json"
            write_json(response_path, stripped_generation(response) if stage == "generate" else response)
            attempt.update(status="complete", elapsedSeconds=round(time.monotonic() - started, 4), endedAt=utc_now(),
                           responsePath=str(response_path), responseSha256=file_hash(response_path))
            return response
        except Exception as error:
            attempt.update(status="failed", error=str(error), elapsedSeconds=round(time.monotonic() - started, 4), endedAt=utc_now())
            raise
        finally:
            write_json(state_path, state)

    tasks = {task["id"]: task for task in manifest["tasks"]}
    methods = {method["id"]: method for method in manifest["methods"]}
    state.setdefault("preparationFailures", {})
    state.setdefault("generationFailures", {})
    if args.phase in ("prepare", "all"):
        for job in manifest["jobs"]:
            identifier = job["id"]
            if identifier in state["preparations"]:
                continue
            try:
                task, method = tasks[job["taskId"]], methods[job["methodId"]]
                plan = task[method["planKey"]]
                preparation = {"taskId": task["id"], "methodId": method["id"], "planBeforeComposition": plan}
                if method["compose"]:
                    response = perform("compose", identifier, "/api/lora/compose", {"semantic_plan": plan})
                    plan = response["semantic_plan"]
                    if not plan.get("promptRealization"):
                        raise ValueError(f"Composition response omitted realization for {identifier}")
                    preparation["composition"] = response
                payload = {"pattern_id": task["patternId"], "pattern_name": task["reference"]["pattern"]["name"],
                           "semantic_plan": plan, "seed": task["seed"], "carrier": "实验二维纹样",
                           **manifest["parameters"]}
                preview = perform("preview", identifier, "/api/lora/preview", payload)
                if preview.get("compiler_version") != manifest["expectedCompiler"]:
                    raise ValueError(f"Preview compiler changed for {identifier}")
                if method["compose"] and not preview.get("semantic_plan", {}).get("promptRealization"):
                    raise ValueError(f"Preview dropped realization for {identifier}")
                preparation.update(payload=payload, preview=preview, preparedAt=utc_now())
                state["preparations"][identifier] = preparation
                state["preparationFailures"].pop(identifier, None)
                write_json(state_path, state)
                print(f"prepared {identifier}: {preview.get('prompt_token_count')} tokens; omitted {preview.get('omitted_concept_ids', [])}", flush=True)
            except Exception as error:
                state["preparationFailures"][identifier] = {**job, "status": "failed", "error": str(error), "recordedAt": utc_now()}
                write_json(state_path, state)
                print(f"preparation failed {identifier}: {error}", flush=True)
                if not args.continue_on_error:
                    raise

    if args.phase in ("generate", "all"):
        if len(state["preparations"]) != len(manifest["jobs"]) and not args.continue_on_error:
            raise ValueError("Prepare every method first so all language-model work precedes image generation")
        negative_prompts = {value["preview"]["negative_prompt"] for value in state["preparations"].values()}
        if len(negative_prompts) != 1:
            raise ValueError("Negative prompts differ across experimental conditions")
        for job in manifest["jobs"]:
            identifier = job["id"]
            if identifier not in state["preparations"]:
                state["generationFailures"][identifier] = {**job, "status": "not-prepared", "recordedAt": utc_now(),
                                                          "error": "Image generation was skipped because this method's preparation failed or is missing"}
                write_json(state_path, state)
                print(f"skipped unprepared {identifier}; no substitute prompt used", flush=True)
                continue
            task = tasks[job["taskId"]]
            preparation = state["preparations"][identifier]
            if identifier in state["jobs"]:
                verify_generation(state["jobs"][identifier]["generation"], task, manifest["parameters"],
                                  preparation["preview"], manifest["expectedCompiler"])
                print(f"verified existing {identifier}", flush=True)
                continue
            try:
                response = perform("generate", identifier, "/api/lora/generate", preparation["payload"])
                record = stripped_generation(response)
                verify_generation(record, task, manifest["parameters"], preparation["preview"], manifest["expectedCompiler"])
                for candidate in record["candidates"]:
                    candidate["sha256"] = file_hash(Path(candidate["path"]))
                record["metadataSha256"] = file_hash(Path(record["metadata_path"]))
                state["jobs"][identifier] = {"taskId": job["taskId"], "methodId": job["methodId"],
                                            "completedAt": utc_now(), "generation": record}
                state["generationFailures"].pop(identifier, None)
                write_json(state_path, state)
                write_json(output / "runs" / f"{identifier}.json", state["jobs"][identifier])
                print(f"generated {identifier}: {len(record['candidates'])} images in {record.get('inference_seconds')} seconds", flush=True)
            except Exception as error:
                state["generationFailures"][identifier] = {**job, "status": "failed", "error": str(error), "recordedAt": utc_now()}
                write_json(state_path, state)
                print(f"generation failed {identifier}: {error}", flush=True)
                if not args.continue_on_error:
                    raise
        state["finishedAt"] = utc_now()
        state["status"] = "complete" if len(state["jobs"]) == len(manifest["jobs"]) else "partial"
        if state["status"] == "complete":
            state["completedAt"] = state["finishedAt"]
        write_json(state_path, state)
    return 2 if state["preparationFailures"] or state["generationFailures"] else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "outputs" / "reproduction-2026-11-09")
    parser.add_argument("--base-url", default="http://127.0.0.1:8001")
    parser.add_argument("--phase", choices=("prepare", "generate", "all"), default="all")
    parser.add_argument("--continue-on-error", action="store_true",
                        help="Record method failures and continue other jobs, keeping all planned jobs in the denominator")
    args = parser.parse_args()
    if args.base_url.rstrip("/") not in ("http://127.0.0.1:8001", "http://localhost:8001"):
        parser.error("This experiment runner accepts only the configured local service on port 8001")
    args.base_url = args.base_url.rstrip("/")
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "runs").mkdir(exist_ok=True)
    (args.output / "attempts").mkdir(exist_ok=True)
    # No automatic stale-lock removal. A crashed process should be diagnosed and
    # its checkpoint inspected before another process can mutate the same run.
    lock = args.output / ".runner.lock"
    try:
        with lock.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps({"pid": os.getpid(), "startedAt": utc_now()}))
    except FileExistsError:
        parser.error(f"Experiment lock exists at {lock}; confirm the previous runner has stopped")
    try:
        return execute(args)
    finally:
        lock.unlink()


if __name__ == "__main__":
    raise SystemExit(main())

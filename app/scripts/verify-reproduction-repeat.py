"""Repeat one completed paired-experiment batch through the normal local API."""

import argparse
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("reproduction_runner", ROOT / "scripts" / "run-reproduction-experiment.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "outputs" / "reproduction-2026-11-09-v2")
    parser.add_argument("--job", default="T01-A")
    args = parser.parse_args()
    manifest = runner.read_json(args.output / "manifest.json")
    state = runner.read_json(args.output / "experiment-state.json")
    manifest_hash = runner.file_hash(args.output / "manifest.json")
    if state["manifestSha256"] != manifest_hash:
        raise ValueError("Experiment state and protocol do not match")
    original = state["jobs"][args.job]
    preparation = state["preparations"][args.job]
    task = next(item for item in manifest["tasks"] if item["id"] == original["taskId"])
    runner.verify_generation(original["generation"], task, manifest["parameters"], preparation["preview"], manifest["expectedCompiler"])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base_url = "http://127.0.0.1:8001"
    health = runner.request_json(opener, base_url, "/api/lora/health")
    if health.get("active_task") or health.get("queued_tasks"):
        raise RuntimeError("Wait until the controlled generation experiment releases the GPU")
    if health["compiler_version"] != manifest["expectedCompiler"]:
        raise ValueError("The running service has a different compiler")
    response = runner.request_json(opener, base_url, "/api/lora/generate", preparation["payload"])
    repeated = runner.stripped_generation(response)
    runner.verify_generation(repeated, task, manifest["parameters"], preparation["preview"], manifest["expectedCompiler"])
    comparisons = []
    for old, new in zip(original["generation"]["candidates"], repeated["candidates"]):
        actual = runner.file_hash(Path(new["path"]))
        comparisons.append({"seed": new["seed"], "originalSha256": old["sha256"],
                            "repeatSha256": actual, "identical": old["sha256"] == actual})
    report = {"createdAt": datetime.now(timezone.utc).isoformat(), "job": args.job,
              "manifestSha256": manifest_hash, "originalRunId": original["generation"]["id"],
              "repeat": repeated, "comparisons": comparisons,
              "interpretation": "Same local runtime, prompt, parameters and seeds. These extra images are excluded from the 96 planned experimental samples."}
    runner.write_json(args.output / "repeat-verification.json", report)
    identical = sum(item["identical"] for item in comparisons)
    print(f"Repeated {args.job}: {identical}/{len(comparisons)} PNG files have identical SHA256", flush=True)
    if identical != len(comparisons):
        raise RuntimeError("Repeated images differed. See repeat-verification.json for the observed result.")


if __name__ == "__main__":
    main()

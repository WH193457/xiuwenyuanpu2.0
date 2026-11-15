"""Integrity checks for the experiment runner, without HTTP or model inference."""

import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run-reproduction-experiment.py"
SPEC = importlib.util.spec_from_file_location("reproduction_runner", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ExperimentIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.image = Path(self.directory.name) / "image.png"
        self.image.write_bytes(b"a test fixture, not an actual experiment image")
        self.parameters = {"steps": 30, "count": 3, "lora_scale": 0.35}
        self.task = {"seeds": [20, 21, 22]}
        self.preview = {"prompt": "dongzu, butterfly", "negative_prompt": "text"}
        self.record = {"status": "complete", "compiler_version": "test", **self.parameters, **self.preview,
                       "candidates": [{"seed": seed, "path": str(self.image), "sha256": runner.file_hash(self.image)}
                                      for seed in self.task["seeds"]]}

    def verify(self):
        runner.verify_generation(self.record, self.task, self.parameters, self.preview, "test")

    def test_completed_job_can_resume_when_every_hash_and_setting_matches(self):
        self.verify()

    def test_modified_image_invalidates_resume(self):
        self.image.write_bytes(b"changed fixture")
        with self.assertRaisesRegex(ValueError, "image has changed"):
            self.verify()

    def test_prompt_and_seed_mismatch_are_rejected(self):
        self.record["prompt"] = "other prompt"
        with self.assertRaisesRegex(ValueError, "prompt differs"):
            self.verify()
        self.record["prompt"] = self.preview["prompt"]
        self.record["candidates"][1]["seed"] = 999
        with self.assertRaisesRegex(ValueError, "seeds differ"):
            self.verify()

    def test_nonmatching_parameters_and_incomplete_status_are_rejected(self):
        self.record["lora_scale"] = 1
        with self.assertRaisesRegex(ValueError, "parameter mismatch"):
            self.verify()
        self.record["lora_scale"] = 0.35
        self.record["status"] = "failed"
        with self.assertRaisesRegex(ValueError, "status/compiler"):
            self.verify()

    def test_json_checkpoint_and_base64_removal_preserve_metadata(self):
        path = Path(self.directory.name) / "checkpoint.json"
        runner.write_json(path, {"中文": [1, 2]})
        self.assertEqual(runner.read_json(path), {"中文": [1, 2]})
        response = {**self.record, "image_data_url": "base64", "candidates": [{"seed": 20, "image": "base64", "path": "real.png"}]}
        stripped = runner.stripped_generation(response)
        self.assertNotIn("image_data_url", stripped)
        self.assertEqual(stripped["candidates"], [{"seed": 20, "path": "real.png"}])
        self.assertIn("image", response["candidates"][0])

    def test_continue_on_error_preserves_failed_arm_without_fallback(self):
        output = Path(self.directory.name)
        (output / "attempts").mkdir()
        (output / "runs").mkdir()
        task = {"id": "T", "patternId": "DX027", "seed": 20, "seeds": [20, 21, 22],
                "directPlan": {"version": 1, "concepts": [], "extraPrompt": "butterfly"},
                "reference": {"pattern": {"name": "fixture"}}}
        manifest = {"expectedCompiler": "test", "parameters": self.parameters, "tasks": [task],
                    "methods": [{"id": "A", "planKey": "directPlan", "compose": False},
                                {"id": "B", "planKey": "directPlan", "compose": True}],
                    "jobs": [{"id": "T-A", "taskId": "T", "methodId": "A"},
                             {"id": "T-B", "taskId": "T", "methodId": "B"}],
                    "provenance": {"sourceHashes": {}}}
        runner.write_json(output / "manifest.json", manifest)
        manifest_hash = runner.file_hash(output / "manifest.json")
        (output / "manifest.sha256").write_text(manifest_hash, encoding="utf-8")
        runner.write_json(output / "experiment-state.json", {"manifestSha256": manifest_hash,
                          "environment": {"models": {}}, "preparations": {}, "jobs": {}, "attempts": []})
        metadata = output / "fixture-metadata.json"
        runner.write_json(metadata, self.record)
        called = []

        def response(_opener, _url, endpoint, payload=None):
            called.append(endpoint)
            if endpoint.endswith("health"):
                return {"compiler_version": "test", "runtime_available": True, "language": {"available": True}}
            if endpoint.endswith("compose"):
                raise ValueError("intentional fixture composition failure")
            if endpoint.endswith("preview"):
                return {**self.preview, "compiler_version": "test", "prompt_token_count": 4}
            return {**self.record, "metadata_path": str(metadata)}

        args = SimpleNamespace(output=output, base_url="http://127.0.0.1:8001", phase="all", continue_on_error=True)
        with patch.object(runner, "request_json", side_effect=response):
            self.assertEqual(runner.execute(args), 2)
        state = runner.read_json(output / "experiment-state.json")
        self.assertEqual(state["status"], "partial")
        self.assertEqual(list(state["jobs"]), ["T-A"])
        self.assertIn("T-B", state["preparationFailures"])
        self.assertEqual(state["generationFailures"]["T-B"]["status"], "not-prepared")
        self.assertEqual(called.count("/api/lora/generate"), 1)
        self.assertTrue(any(attempt["status"] == "failed" for attempt in state["attempts"]))


if __name__ == "__main__":
    unittest.main()

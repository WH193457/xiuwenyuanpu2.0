"""Synthetic arithmetic and export fixtures, never saved as experimental data."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

from PIL import Image


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "analyze-reproduction-experiment.py"
SPEC = importlib.util.spec_from_file_location("reproduction_analysis", MODULE_PATH)
analysis = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analysis)


class ReproductionAnalysisTests(unittest.TestCase):
    def test_task_bootstrap_is_reproducible_and_counts_tasks(self):
        first = analysis.interval([0.1, 0.3], 10000, 20261109)
        self.assertEqual(first, analysis.interval([0.1, 0.3], 10000, 20261109))
        self.assertAlmostEqual(first["mean"], 0.2)
        self.assertEqual(first["tasks"], 2)
        self.assertEqual(first["ci95"], [0.1, 0.3])
        self.assertIsNone(analysis.interval([], 10000, 20261109))

    def test_paired_mean_uses_task_units_and_excludes_incomplete_pairs(self):
        manifest = {"tasks": [{"id": "T1"}, {"id": "T2"}],
                    "methods": [{"id": "A"}, {"id": "D"}], "parameters": {"count": 3},
                    "evaluation": {"bootstrap": {"resamples": 100, "seed": 1},
                                   "primaryComparison": "D-A", "exploratoryComparisons": []}}
        samples = []
        for task_id in ("T1", "T2"):
            for method_id, score in (("A", 0.2), ("D", 0.4)):
                for _index in range(2 if (task_id, method_id) == ("T2", "D") else 3):
                    samples.append({"taskId": task_id, "methodId": method_id, "clipCosine": score,
                                    "targetMargin": score - 0.3, "targetTop1": score > 0.3})
        result = analysis.summarize(samples, manifest, {"jobs": {}, "attempts": []})
        comparison = result["contrasts"][0]
        self.assertEqual(comparison["clipCosineDifference"]["tasks"], 1)
        self.assertEqual(comparison["pairedTaskDifferences"][0]["taskId"], "T1")
        self.assertAlmostEqual(comparison["clipCosineDifference"]["mean"], 0.2)

    def test_blind_export_hides_methods_and_starts_with_empty_ratings(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            image_path = output / "fixture.png"
            Image.new("RGB", (32, 32), "red").save(image_path)
            sample = {"id": "T1-secret-method-1", "taskId": "T1", "methodId": "secret-method",
                      "seed": 17, "path": str(image_path), "sha256": analysis.file_hash(image_path)}
            manifest = {"tasks": [{"id": "T1", "title": "测试用任务", "evaluationTargetEnglish": "test fixture",
                                   "evaluationTargetChinese": "仅用于测试的任务描述"}]}
            analysis.make_blind_review(output, [sample], manifest, "abc123")
            page = (output / "blind-review" / "index.html").read_text(encoding="utf-8")
            self.assertNotIn("secret-method", page)
            self.assertNotIn("methodId", page)
            self.assertIn("ratings: {}", page)
            self.assertIn("identityLocked = true", page)
            self.assertIn("if (!confirm(", page)
            self.assertIn("仅用于测试的任务描述", page)
            self.assertIn("R001", page)
            mapping = analysis.read_json(output / "blind-mapping-researcher-only.json")
            self.assertEqual(mapping["mapping"][0]["methodId"], "secret-method")
            self.assertEqual(analysis.file_hash(output / "blind-review" / "images" / "R001.png"), sample["sha256"])
            self.assertEqual(sorted(path.name for path in (output / "blind-review").iterdir()), ["images", "index.html"])


if __name__ == "__main__":
    unittest.main()

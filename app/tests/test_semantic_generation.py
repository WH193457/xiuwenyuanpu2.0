"""Regression checks for semantic-plan compilation and generation provenance.

Run from the project root with python -B -m unittest discover -s tests.
Image generation is mocked so these checks work without GPU dependencies.
"""

import copy
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import lora_service as service
from prompt_plan import compile_plan, validate_plan
from local_language import parse_refinement


class Tokenizer:
    model_max_length = 77

    def __call__(self, text, **_kwargs):
        return {"input_ids": list(range(len(text.split()) + 2))}


def concept(identifier="subject:蝴蝶", text="butterfly motif", **updates):
    return {
        "id": identifier,
        "dimension": "subject",
        "label": identifier,
        "promptText": text,
        "priority": 2,
        "enabled": True,
        "patternIds": ["DX017"],
        "sourceIds": [],
        "evidence": "visual",
        **updates,
    }


def plan(*concepts, extra=""):
    return {"version": 1, "concepts": list(concepts), "extraPrompt": extra}


class PromptPlanTests(unittest.TestCase):
    def test_priority_order_and_disabled_conditions(self):
        result = compile_plan(plan(
            concept("low", "low saturation", priority=1),
            concept("off", "dragon", enabled=False),
            concept("high", "butterfly", priority=3),
        ), Tokenizer())
        self.assertEqual(result["prompt"], "dongzu, butterfly, low saturation")
        self.assertEqual(result["applied_concept_ids"], ["high", "low"])

    def test_duplicate_clauses_are_deduplicated(self):
        result = compile_plan(plan(concept("one"), concept("two")), Tokenizer())
        self.assertEqual(result["prompt"], "dongzu, butterfly motif")
        self.assertEqual(result["omitted_concept_ids"], ["two"])

    def test_normalizes_english_punctuation(self):
        result = compile_plan(plan(concept(text="bird’s wings，blue-and-white")), Tokenizer())
        self.assertIn("bird's wings,blue-and-white", result["prompt"])

    def test_every_enabled_concept_has_a_disposition(self):
        result = compile_plan(plan(concept("one"), concept("duplicate"), concept("missing", ""), concept("off", enabled=False)), Tokenizer())
        self.assertEqual({item["id"] for item in result["concept_dispositions"]}, {"one", "duplicate", "missing"})
        self.assertEqual(set(result["omitted_concept_ids"]), {"duplicate", "missing"})

    def test_parent_attributes_are_bound_and_budgeted_as_a_group(self):
        original = plan(concept("bird", "bird"), concept("red", "red wings", parentId="bird", dimension="palette"))
        result = compile_plan(original, Tokenizer())
        self.assertEqual(result["prompt"], "dongzu, bird with red wings")
        small = Tokenizer()
        small.model_max_length = 5
        result = compile_plan(original, small)
        self.assertEqual(result["prompt"], "dongzu")
        self.assertEqual(set(result["omitted_concept_ids"]), {"bird", "red"})

    def test_disabled_parent_omits_descendants(self):
        result = compile_plan(plan(concept("bird", enabled=False), concept("red", "red", parentId="bird", dimension="palette")), Tokenizer())
        self.assertEqual(result["applied_concept_ids"], [])
        self.assertEqual(result["omitted_concept_ids"], ["red"])
        self.assertIn("已停用", result["concept_dispositions"][0]["reason"])

    def test_invalid_relationships_are_rejected(self):
        invalid = [plan(concept("a", parentId="missing")),
                   plan(concept("a", parentId="b"), concept("b", parentId="a")),
                   plan(concept("a", dimension="palette"), concept("b", parentId="a"))]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_plan(value)

    def test_four_level_relationships_compile_as_one_group(self):
        original = plan(concept("a", "branch"), concept("b", "bird", parentId="a"),
                        concept("c", "flower", parentId="b"), concept("d", "red petals", parentId="c", dimension="palette"))
        result = compile_plan(original, Tokenizer())
        self.assertEqual(result["prompt"], "dongzu, branch with bird with flower with red petals")
        self.assertEqual(result["applied_concept_ids"], ["a", "b", "c", "d"])

    def test_missing_english_warns_and_preserves_evidence(self):
        original = plan(concept(text="", evidence="cautious"))
        result = compile_plan(original, Tokenizer())
        self.assertEqual(result["semantic_plan"], original)
        self.assertTrue(any("缺少" in warning for warning in result["warnings"]))
        self.assertNotIn("蝴蝶", result["prompt"])

    def test_unicode_extra_is_not_silently_sent_to_clip(self):
        result = compile_plan(plan(extra="新设计"), Tokenizer())
        self.assertEqual(result["prompt"], "dongzu")
        self.assertTrue(result["warnings"])

    def test_budget_omits_whole_lower_priority_clause(self):
        tokenizer = Tokenizer()
        tokenizer.model_max_length = 8
        result = compile_plan(plan(
            concept("low", "long red green and blue palette", priority=1),
            concept("high", "butterfly motif", priority=3),
        ), tokenizer)
        self.assertEqual(result["prompt"], "dongzu, butterfly motif")
        self.assertEqual(result["omitted_concept_ids"], ["low"])
        self.assertLessEqual(result["prompt_token_count"], 8)

    def test_validation_rejects_unsupported_and_duplicate_fields(self):
        examples = [None, {"version": True, "concepts": []}, {"version": 2, "concepts": []},
                    plan(concept(priority=True)), plan(concept(dimension="unknown")),
                    plan(concept(), concept()), plan(concept(enabled="false"))]
        for example in examples:
            with self.subTest(example=example), self.assertRaises(ValueError):
                validate_plan(example)

    def test_validation_does_not_mutate_input(self):
        original = plan(concept())
        previous = copy.deepcopy(original)
        compile_plan(original, Tokenizer())
        self.assertEqual(original, previous)

    def test_semantic_plan_replaces_legacy_fields(self):
        payload = {"semantic_plan": plan(concept()), "pattern_name": "凤凰", "composition": "放射式", "palette": "古绢朱青"}
        result = service.preview_prompt(payload, Tokenizer())
        self.assertEqual(result["prompt"], "dongzu, butterfly motif")
        self.assertNotIn("phoenix", result["prompt"])

    def test_legacy_prompt_still_uses_original_compiler(self):
        payload = {"pattern_name": "凤凰", "composition": "放射式", "palette": "古绢朱青"}
        result = service.preview_prompt(payload)
        self.assertEqual((result["prompt"], result["negative_prompt"]), service.build_prompt(payload))
        self.assertIn("phoenix", result["prompt"])

    def test_language_model_output_preserves_provenance_and_relationships(self):
        original = plan(concept("bird", "", evidence="cautious"), concept("red", "", parentId="bird", dimension="palette"))
        raw = json.dumps({"translations": [{"id": "bird", "promptText": "bird"}, {"id": "red", "promptText": "red wings"}], "extraPrompt": "white background"})
        result = parse_refinement(raw, original, "白色背景")
        self.assertEqual(result["concepts"][0]["evidence"], "cautious")
        self.assertEqual(result["concepts"][1]["parentId"], "bird")
        self.assertEqual(result["concepts"][0]["patternIds"], ["DX017"])

    def test_language_model_invalid_ids_and_missing_concepts_fail(self):
        for translations in [[], [{"id": "new", "promptText": "bird"}], [{"id": "bird", "promptText": "中文"}]]:
            with self.subTest(translations=translations), self.assertRaises(ValueError):
                parse_refinement(json.dumps({"translations": translations, "extraPrompt": ""}), plan(concept("bird")), "")

    def test_language_aliases_restore_uuid_without_changing_relationships(self):
        identifier = "user:701913c1-6f21-4d3a-9ad2-e9419415f631"
        original = plan(concept(identifier), concept("child", parentId=identifier, dimension="palette"))
        raw = json.dumps({"translations": [{"id": "c1", "promptText": "flying crane"},
                                             {"id": "c2", "promptText": "blue feathers"}], "extraPrompt": ""})
        result = parse_refinement(raw, original, "", {"c1": identifier, "c2": "child"})
        self.assertEqual(result["concepts"][0]["id"], identifier)
        self.assertEqual(result["concepts"][1]["parentId"], identifier)
        with self.assertRaises(ValueError):
            parse_refinement(raw.replace('"c1"', '"c9"'), original, "", {"c1": identifier, "c2": "child"})


class FakeImage:
    def save(self, destination, **_kwargs):
        if isinstance(destination, io.BytesIO):
            destination.write(b"test image")
        else:
            Path(destination).write_bytes(b"test image")


class FakeGenerator:
    def __init__(self, **_kwargs):
        self.seed = None

    def manual_seed(self, seed):
        self.seed = seed
        return self


class FakeTorch:
    Generator = FakeGenerator


class Pipeline:
    device = "cpu"
    tokenizer = Tokenizer()

    def __init__(self, fail_after=None):
        self.calls = []
        self.fail_after = fail_after
        self.adapter_weights = []

    def set_adapters(self, name, adapter_weights):
        self.adapter_weights.append((name, adapter_weights))

    def __call__(self, **kwargs):
        if self.fail_after is not None and len(self.calls) >= self.fail_after:
            raise RuntimeError("deliberate test failure")
        self.calls.append(kwargs)
        return type("Result", (), {"images": [FakeImage()]})()


class GenerationTests(unittest.TestCase):
    def test_invalid_request_does_not_load_model(self):
        for invalid in [{"width": 513}, {"guidance": float("nan")}, {"seed": -1},
                        {"seed": 1.5}, {"steps": True},
                        {"lora_scale": False}, {"semantic_plan": {"version": 2}}]:
            with self.subTest(invalid=invalid), patch.object(service, "load_pipeline") as loader:
                with self.assertRaises(ValueError):
                    service.generate(invalid)
                loader.assert_not_called()

    def test_generation_metadata_seed_zero_and_unique_runs(self):
        pipeline = Pipeline()
        payload = {"semantic_plan": plan(concept()), "pattern_id": "../../DX017", "seed": 0, "count": 2,
                   "lora_scale": 0.35, "reference_id": "reference-test", "assistance": {"model": "local-model"}}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(service, "OUTPUT_ROOT", Path(directory)), \
                patch.object(service, "load_pipeline", return_value=pipeline), \
                patch.object(service, "cached_tokenizer", return_value=pipeline.tokenizer), \
                patch.object(service, "TORCH", FakeTorch):
            first = service.generate(payload)
            second = service.generate(payload)
            self.assertNotEqual(first["id"], second["id"])
            self.assertEqual([item["seed"] for item in first["candidates"]], [0, 1])
            self.assertEqual(first["prompt"], service.preview_prompt(payload, pipeline.tokenizer)["prompt"])
            saved = json.loads(Path(first["metadata_path"]).read_text(encoding="utf-8"))
            self.assertEqual(saved["status"], "complete")
            self.assertEqual(saved["semantic_plan"], payload["semantic_plan"])
            self.assertEqual(saved["lora_scale"], 0.35)
            self.assertEqual(saved["request_context"]["reference_id"], "reference-test")
            self.assertEqual(saved["request_context"]["assistance"], {"model": "local-model"})
            self.assertEqual(pipeline.adapter_weights, [(service.ADAPTER_NAME, value) for value in [0.35, 1.0, 0.35, 1.0]])
            self.assertNotIn("image", saved["candidates"][0])
            for candidate in first["candidates"]:
                self.assertTrue(Path(candidate["path"]).resolve().is_relative_to(Path(directory).resolve()))
            self.assertFalse(list(Path(directory).rglob("*.tmp")))

    def test_partial_failure_is_recorded(self):
        pipeline = Pipeline(fail_after=1)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(service, "OUTPUT_ROOT", Path(directory)), \
                patch.object(service, "load_pipeline", return_value=pipeline), \
                patch.object(service, "cached_tokenizer", return_value=pipeline.tokenizer), \
                patch.object(service, "TORCH", FakeTorch):
            with self.assertRaises(RuntimeError):
                service.generate({"semantic_plan": plan(concept()), "seed": 3})
            saved = json.loads(next(Path(directory).rglob("generation.json")).read_text(encoding="utf-8"))
            self.assertEqual(saved["status"], "failed")
            self.assertEqual(len(saved["candidates"]), 1)
            self.assertEqual(pipeline.adapter_weights[-1], (service.ADAPTER_NAME, 1.0))

    def test_refinement_validates_before_reserving_gpu(self):
        with patch.object(service, "unload_pipeline") as unload:
            with self.assertRaises(ValueError):
                service.refine({"semantic_plan": plan(concept()), "brief": ["invalid"]})
            unload.assert_not_called()

    def test_model_tasks_serialize_and_release_after_failure(self):
        entered = threading.Event()
        finished = threading.Event()

        def second_task():
            entered.set()
            with service.model_task("language"):
                finished.set()

        with self.assertRaisesRegex(RuntimeError, "test"), service.model_task("generation"):
            thread = threading.Thread(target=second_task)
            thread.start()
            self.assertTrue(entered.wait(2))
            self.assertFalse(finished.is_set())
            self.assertEqual(service.ACTIVE_TASK, "generation")
            raise RuntimeError("test")
        thread.join(timeout=2)
        self.assertTrue(finished.is_set())
        self.assertEqual(service.QUEUED_TASKS, 0)
        self.assertIsNone(service.ACTIVE_TASK)

    def test_http_preview_and_bad_request_work_without_gpu(self):
        server = service.ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(service, "cached_tokenizer", return_value=Tokenizer()), \
                    patch.object(service, "load_pipeline") as loader:
                endpoint = f"http://127.0.0.1:{server.server_port}/api/lora/preview"
                request = Request(endpoint, data=json.dumps({"semantic_plan": plan(concept())}).encode(), headers={"Content-Type": "application/json"})
                with urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response)["prompt"], "dongzu, butterfly motif")
                for value in [[], {"semantic_plan": {"version": 2}}]:
                    with self.assertRaises(HTTPError) as caught:
                        urlopen(Request(endpoint, data=json.dumps(value).encode()), timeout=5)
                    self.assertEqual(caught.exception.code, 400)
                loader.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()

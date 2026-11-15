import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import lora_service as service
from local_language import composition_request, parse_composition
from prompt_plan import compile_plan, plan_fingerprint, preserved_group_text, realization_groups, validate_plan
from test_semantic_generation import concept, plan, Tokenizer, Pipeline, FakeTorch


def composed_plan(value, texts):
    normalized = validate_plan(value)
    groups = realization_groups(normalized)
    normalized["promptRealization"] = {
        "version": 1, "sourceFingerprint": plan_fingerprint(normalized), "model": "test-local-model",
        "groups": [{"rootId": group["rootId"], "conceptIds": group["conceptIds"], "text": text}
                   for group, text in zip(groups, texts)],
    }
    return validate_plan(normalized)


class CanvasCompositionTests(unittest.TestCase):
    def test_hierarchical_groups_and_whole_canvas_input(self):
        original = plan(concept("bird", "two birds", label="两只鸟"),
                        concept("color", "red wings", dimension="palette", parentId="bird"),
                        concept("style", "embroidery", dimension="style", priority=1),
                        concept("off", "flower", enabled=False),
                        concept("off-child", "yellow", dimension="palette", parentId="off"), extra="米白色背景")
        original["context"] = {"goal": "minimal", "brief": "留白", "algorithm": "context-walk-v2",
                               "focusConceptIds": ["bird"], "excludedConceptIds": []}
        normalized = validate_plan(original)
        request, aliases = composition_request(normalized)
        self.assertEqual(len(request["canvas"]), 5)
        self.assertEqual(request["canvas"][1]["parentId"], "c1")
        self.assertEqual(request["context"]["focusConceptIds"], ["c1"])
        self.assertEqual([row["conceptIds"] for row in request["groups"]], [["c1", "c2"], ["c3"], ["extraPrompt"]])
        raw = json.dumps({"groups": [{"rootId": "g3", "text": "ivory background"},
                                     {"rootId": "g1", "text": "two birds with red wings"},
                                     {"rootId": "g2", "text": "crisp embroidery"}]})
        result = parse_composition(raw, normalized, aliases)
        self.assertEqual(result["concepts"], normalized["concepts"])
        compiled = compile_plan(result, Tokenizer())
        self.assertEqual(compiled["prompt"], "dongzu, two birds with red wings, crisp embroidery, ivory background")
        self.assertEqual(set(compiled["applied_concept_ids"]), {"bird", "color", "style", "extraPrompt"})
        self.assertEqual(compiled["omitted_concept_ids"], ["off-child"])

    def test_realized_group_is_budgeted_as_a_whole(self):
        value = composed_plan(plan(concept("bird", "bird"),
                              concept("red", "red wings", dimension="palette", parentId="bird")), ["bird with red wings"])
        tokenizer = Tokenizer()
        tokenizer.model_max_length = 5
        result = compile_plan(value, tokenizer)
        self.assertEqual(result["prompt"], "dongzu")
        self.assertEqual(set(result["omitted_concept_ids"]), {"bird", "red"})

    def test_compose_translates_concepts_with_no_previous_english(self):
        value = composed_plan(plan(concept("bird", "", label="两只红色鸟")), ["two red birds"])
        result = compile_plan(value, Tokenizer())
        self.assertEqual(result["prompt"], "dongzu, two red birds")
        self.assertEqual(result["omitted_concept_ids"], [])

    def test_semantic_edits_invalidate_realization(self):
        original = composed_plan(plan(concept("bird", "bird"), extra="white background"), ["bird motif", "white background"])
        changes = [lambda item: item["concepts"][0].update(label="新主体"),
                   lambda item: item["concepts"][0].update(priority=3),
                   lambda item: item["concepts"][0].update(promptText="fish"),
                   lambda item: item["concepts"][0].update(enabled=False),
                   lambda item: item.update(extraPrompt="blue background"),
                   lambda item: item.update(context={"goal": "repeat", "algorithm": "context-walk-v2", "brief": "",
                                                     "focusConceptIds": [], "excludedConceptIds": []})]
        for change in changes:
            edited = copy.deepcopy(original)
            change(edited)
            self.assertNotIn("promptRealization", validate_plan(edited))

    def test_provenance_and_translation_do_not_invalidate(self):
        value = composed_plan(plan(concept("bird", "bird"), extra="米白色背景"), ["bird motif", "ivory background"])
        fingerprint = value["promptRealization"]["sourceFingerprint"]
        value["concepts"][0]["sourceIds"] = ["S01"]
        value["extraPromptTranslation"] = {"sourceText": "米白色背景", "text": "ivory background", "model": "translation"}
        self.assertEqual(validate_plan(value)["promptRealization"]["sourceFingerprint"], fingerprint)

    def test_current_realization_rejects_missing_or_cross_group_ids(self):
        value = composed_plan(plan(concept("bird", "bird"), concept("red", "red", dimension="palette")), ["bird", "red"])
        for groups in [value["promptRealization"]["groups"][:1],
                       [value["promptRealization"]["groups"][0]] * 2,
                       [{"rootId": "bird", "conceptIds": ["bird", "red"], "text": "red bird"},
                        value["promptRealization"]["groups"][1]]]:
            edited = copy.deepcopy(value)
            edited["promptRealization"]["groups"] = groups
            with self.assertRaises(ValueError):
                validate_plan(edited)

    def test_subject_color_and_count_losses_are_rejected(self):
        value = plan(concept("butterflies", "two red butterflies", label="两只红色蝴蝶"))
        for text in ["two red flowers", "two blue butterflies", "red butterfly", "两只红色蝴蝶"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                composed_plan(value, [text])
        self.assertIn("promptRealization", composed_plan(value, ["paired red butterflies"]))

    def test_empty_canvas_and_unknown_duplicate_alias_are_rejected(self):
        with self.assertRaises(ValueError):
            composition_request(validate_plan(plan()))
        normalized = validate_plan(plan(concept("bird", "bird")))
        _request, aliases = composition_request(normalized)
        for raw in ["not JSON", '{"groups":[]}', '{"groups":[{"rootId":"bird","text":"bird"}]}',
                    '{"groups":[{"rootId":"g1","text":"bird"},{"rootId":"g1","text":"bird"}]}']:
            with self.assertRaises(ValueError):
                parse_composition(raw, normalized, aliases)

    def test_attributes_cannot_leak_into_other_groups(self):
        value = plan(concept("butterfly", "butterfly with blue wings"),
                     concept("symmetry", "bilateral symmetry", dimension="composition"), extra="ivory background")
        with self.assertRaisesRegex(ValueError, "该组没有"):
            composed_plan(value, ["blue butterfly with blue wings", "bilateral symmetry with blue wings", "ivory background"])
        with self.assertRaisesRegex(ValueError, "该组没有"):
            composed_plan(value, ["blue butterfly with blue wings", "bilateral symmetry", "ivory background with red flowers"])
        result = composed_plan(value, ["butterfly with blue wings", "bilateral symmetry", "ivory background"])
        self.assertIn("promptRealization", result)

    def test_preserved_origin_requires_exact_atomic_non_subject_text(self):
        value = composed_plan(plan(concept("style", "minimal style", dimension="style")), ["minimal style"])
        value["promptRealization"]["groups"][0]["origin"] = "preserved"
        self.assertEqual(validate_plan(value)["promptRealization"]["groups"][0]["origin"], "preserved")
        value["promptRealization"]["groups"][0]["text"] = "beautiful minimal style"
        with self.assertRaisesRegex(ValueError, "原英文一致"):
            validate_plan(value)
        subject = composed_plan(plan(concept("bird", "bird")), ["bird"])
        subject["promptRealization"]["groups"][0]["origin"] = "preserved"
        with self.assertRaises(ValueError):
            validate_plan(subject)

    def test_routing_is_decided_before_model_output(self):
        value = validate_plan(plan(concept("bird", "bird"),
                                   concept("blue", "blue wings", dimension="palette", parentId="bird"),
                                   concept("style", "minimal style", dimension="style"),
                                   concept("chinese", "", label="留白", dimension="composition"), extra="white background"))
        groups = realization_groups(value)
        self.assertEqual([preserved_group_text(group) for group in groups], [None, "minimal style", None, None])
        request, _aliases = composition_request(value)
        self.assertEqual([group["route"] for group in request["groups"]], ["model", "preserved", "model", "model"])

    def test_legacy_realization_origin_defaults_to_model(self):
        value = composed_plan(plan(concept("bird", "bird")), ["bird"])
        value["promptRealization"]["groups"][0].pop("origin")
        self.assertEqual(validate_plan(value)["promptRealization"]["groups"][0]["origin"], "model")

    def test_compose_endpoint_uses_shared_lock(self):
        value = plan(concept("bird", "bird"))
        def compose(normalized):
            self.assertEqual(service.ACTIVE_TASK, "language")
            self.assertFalse(service.INFERENCE_LOCK.acquire(blocking=False))
            return {"semantic_plan": composed_plan(normalized, ["bird"]), "model": "test", "elapsed_seconds": 0, "warnings": []}
        with patch.object(service, "unload_pipeline") as unload, patch.object(service, "compose_plan", side_effect=compose):
            result = service.compose({"semantic_plan": value})
        unload.assert_called_once()
        self.assertIn("promptRealization", result["semantic_plan"])
        self.assertIsNone(service.ACTIVE_TASK)

    def test_preview_and_generation_reuse_approved_prose_without_model_calls(self):
        value = composed_plan(plan(concept("bird", "bird"), extra="米白背景"), ["bird motif", "ivory background"])
        request = {"semantic_plan": value, "seed": 0, "count": 2}
        pipeline = Pipeline()
        with tempfile.TemporaryDirectory() as directory, patch.object(service, "OUTPUT_ROOT", Path(directory)), \
                patch.object(service, "refine_plan") as translator, patch.object(service, "compose_plan") as composer, \
                patch.object(service, "cached_tokenizer", return_value=Tokenizer()), \
                patch.object(service, "load_pipeline", return_value=pipeline), patch.object(service, "TORCH", FakeTorch):
            preview = service.preview(request)
            generated = service.generate(request)
        translator.assert_not_called()
        composer.assert_not_called()
        self.assertEqual(preview["prompt"], generated["prompt"])
        self.assertEqual(generated["semantic_plan"]["promptRealization"], value["promptRealization"])
        self.assertTrue(all(call["prompt"] == "dongzu, bird motif, ivory background" for call in pipeline.calls))


if __name__ == "__main__":
    unittest.main()

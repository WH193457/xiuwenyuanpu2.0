import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import lora_service as service
from prompt_plan import compile_plan, validate_plan
from test_semantic_generation import concept, plan, Tokenizer, Pipeline, FakeTorch


class BilingualSupplementTests(unittest.TestCase):
    def setUp(self):
        service.SUPPLEMENT_TRANSLATIONS.clear()

    def proposal(self, text="ivory background, red butterfly"):
        return {"semantic_plan": plan(extra=text), "model": "local-test-model", "elapsed_seconds": 1, "warnings": []}

    def test_english_and_normalized_punctuation_need_no_model(self):
        for text in ["", "ivory background", "red butterfly，white background。"]:
            with self.subTest(text=text), patch.object(service, "refine_plan") as translator:
                prepared = service.prepare_supplement({"semantic_plan": plan(extra=text)})
                translator.assert_not_called()
                self.assertNotIn("extraPromptTranslation", prepared["semantic_plan"])
                if text:
                    self.assertIn("extraPrompt", compile_plan(prepared["semantic_plan"], Tokenizer())["applied_concept_ids"])

    def test_chinese_and_mixed_text_translated_without_changing_canvas(self):
        for source in ["米白色背景，红色蝴蝶", "米白色背景，保留 red butterfly"]:
            original = {"semantic_plan": plan(concept("subject", "butterfly"), extra=source)}
            snapshot = copy.deepcopy(original)
            with patch.object(service, "language_status", return_value={"available": True}), \
                    patch.object(service, "unload_pipeline"), \
                    patch.object(service, "refine_plan", return_value=self.proposal()) as translator:
                prepared = service.prepare_supplement(original)
                self.assertEqual(translator.call_args.args[0]["concepts"], [])
            self.assertEqual(original, snapshot)
            self.assertEqual(prepared["semantic_plan"]["concepts"], snapshot["semantic_plan"]["concepts"])
            compiled = compile_plan(prepared["semantic_plan"], Tokenizer())
            self.assertIn("ivory background, red butterfly", compiled["prompt"])
            self.assertEqual(compiled["semantic_plan"]["extraPrompt"], source)
            self.assertEqual(compiled["semantic_plan"]["extraPromptTranslation"]["sourceText"], source)

    def test_preview_and_generation_reuse_same_translation(self):
        request = {"semantic_plan": plan(extra="米白色背景"), "seed": 0, "count": 2}
        pipeline = Pipeline()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(service, "OUTPUT_ROOT", Path(directory)), \
                patch.object(service, "language_status", return_value={"available": True}), \
                patch.object(service, "unload_pipeline") as unload, \
                patch.object(service, "refine_plan", return_value=self.proposal("ivory background")) as translator, \
                patch.object(service, "cached_tokenizer", return_value=Tokenizer()), \
                patch.object(service, "load_pipeline", return_value=pipeline), \
                patch.object(service, "TORCH", FakeTorch):
            preview = service.preview(request)
            generated = service.generate(request)
            translator.assert_called_once()
            unload.assert_called_once()
            self.assertEqual(preview["prompt"], generated["prompt"])
            self.assertTrue(all(call["prompt"] == "dongzu, ivory background" for call in pipeline.calls))
            self.assertEqual(generated["semantic_plan"]["extraPrompt"], "米白色背景")

    def test_restored_translation_needs_no_language_model(self):
        value = plan(extra="米白色背景")
        value["extraPromptTranslation"] = {"sourceText": "米白色背景", "text": "ivory background", "model": "local-test-model"}
        with patch.object(service, "refine_plan") as translator:
            prepared = service.prepare_supplement({"semantic_plan": value})
        translator.assert_not_called()
        self.assertEqual(compile_plan(prepared["semantic_plan"], Tokenizer())["prompt"], "dongzu, ivory background")

    def test_edit_invalidates_previous_translation(self):
        value = plan(extra="蓝色背景")
        value["extraPromptTranslation"] = {"sourceText": "米白色背景", "text": "ivory background", "model": "local-test-model"}
        self.assertNotIn("extraPromptTranslation", validate_plan(value))
        with patch.object(service, "language_status", return_value={"available": True}), \
                patch.object(service, "unload_pipeline"), \
                patch.object(service, "refine_plan", return_value=self.proposal("blue background")):
            prepared = service.prepare_supplement({"semantic_plan": value})
        self.assertEqual(compile_plan(prepared["semantic_plan"], Tokenizer())["prompt"], "dongzu, blue background")

    def test_model_missing_stops_generation_before_loading_image_model(self):
        with patch.object(service, "language_status", return_value={"available": False}), patch.object(service, "load_pipeline") as loader:
            with self.assertRaisesRegex(FileNotFoundError, "补充描述包含中文"):
                service.generate({"semantic_plan": plan(extra="红色背景")})
            loader.assert_not_called()

    def test_translation_failure_is_not_cached_or_silently_omitted(self):
        with patch.object(service, "language_status", return_value={"available": True}), \
                patch.object(service, "unload_pipeline"), \
                patch.object(service, "refine_plan", return_value=self.proposal("仍是中文")), \
                patch.object(service, "load_pipeline") as loader:
            with self.assertRaises(ValueError):
                service.generate({"semantic_plan": plan(extra="蓝色背景")})
            loader.assert_not_called()
            self.assertEqual(len(service.SUPPLEMENT_TRANSLATIONS), 0)

    def test_cache_is_bounded(self):
        with patch.object(service, "language_status", return_value={"available": True}), \
                patch.object(service, "unload_pipeline"), patch.object(service, "refine_plan", return_value=self.proposal()):
            for index in range(34):
                service.prepare_supplement({"semantic_plan": plan(extra=f"中文描述{index}")})
        self.assertEqual(len(service.SUPPLEMENT_TRANSLATIONS), 32)
        self.assertNotIn("中文描述0", service.SUPPLEMENT_TRANSLATIONS)


if __name__ == "__main__":
    unittest.main()

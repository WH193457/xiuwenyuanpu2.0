"""Regression coverage for subject-first prompts and intent-aware exclusions."""
import copy
import unittest

import lora_service as service
from prompt_plan import plan_fingerprint
from test_semantic_generation import Tokenizer, concept, plan


class GenerationPolicyTests(unittest.TestCase):
    def preview(self, value, tokenizer=None):
        return service.preview_prompt({"semantic_plan": value, "generation_profile": "subject-fidelity"}, tokenizer or Tokenizer())

    def test_old_profile_keeps_exact_prompt_and_negative(self):
        value = plan(concept())
        old = service.preview_prompt({"semantic_plan": value}, Tokenizer())
        explicit = service.preview_prompt({"semantic_plan": value, "generation_profile": "standard"}, Tokenizer())
        self.assertEqual(old, explicit)
        self.assertEqual(old["prompt"], "dongzu, butterfly motif")
        self.assertEqual(old["negative_prompt"], service.NEGATIVE_PROMPT)

    def test_subject_group_precedes_high_priority_style_and_keeps_attributes(self):
        value = plan(concept("style", "geometric stylization", dimension="style", priority=3),
                     concept("butterfly", "butterfly", priority=1),
                     concept("blue", "blue", dimension="palette", parentId="butterfly", priority=1))
        before = copy.deepcopy(value)
        result = self.preview(value)
        self.assertEqual(result["prompt"], "butterfly with blue, geometric stylization")
        self.assertEqual(result["fixed_prompt_prefix"], "")
        self.assertEqual(value, before)
        self.assertEqual(len(result["applied_concept_ids"]), 3)

    def test_centered_subject_suppresses_unsolicited_frames_and_tiling(self):
        result = self.preview(plan(concept(), concept("layout", "centered composition", dimension="composition")))
        self.assertIn("embroidery hoop", result["negative_prompt"])
        self.assertIn("ornamental border", result["negative_prompt"])
        self.assertIn("repeating pattern", result["negative_prompt"])

    def test_requested_border_band_is_retained(self):
        result = self.preview(plan(concept("zigzag", "zigzag border"),
                                   concept("band", "horizontal repeating band", dimension="composition")))
        self.assertNotIn("border", result["negative_prompt"])
        self.assertIn("picture frame", result["negative_prompt"])
        self.assertNotIn("repeating pattern", result["negative_prompt"])
        self.assertIn("vertical stripes", result["negative_prompt"])
        self.assertEqual(result["generation_policy"]["layout"], "horizontal-band")

    def test_requested_frames_are_retained_in_supplement(self):
        result = self.preview(plan(concept(), extra="inside a circular frame"))
        self.assertNotIn("frame", result["negative_prompt"])
        self.assertTrue(result["generation_policy"]["border_requested"])

    def test_negated_frame_does_not_disable_frame_suppression(self):
        result = self.preview(plan(concept(), extra="no border, repeat butterflies horizontally"))
        self.assertIn("ornamental border", result["negative_prompt"])
        self.assertNotIn("repeating pattern", result["negative_prompt"])

    def test_centered_row_of_figures_keeps_repetition(self):
        result = self.preview(plan(concept("figures", "row of dancing figures"),
                                   concept("center", "centered composition", dimension="composition")))
        self.assertNotIn("repeating pattern", result["negative_prompt"])

    def test_disabled_parent_cannot_request_a_frame(self):
        result = self.preview(plan(concept("butterfly", "butterfly"),
                                   concept("bird", "bird", enabled=False),
                                   concept("frame", "ornamental border", parentId="bird", dimension="composition")))
        self.assertIn("ornamental border", result["negative_prompt"])

    def test_child_layout_does_not_impose_global_isolation(self):
        result = self.preview(plan(concept("bird", "bird"),
                                   concept("local", "centered composition", parentId="bird", dimension="composition")))
        self.assertNotIn("repeating pattern", result["negative_prompt"])

    def test_global_band_preserves_vertical_stripes_on_a_subject(self):
        result = self.preview(plan(concept("bird", "bird motif"),
                                   concept("local", "vertical stripes", parentId="bird", dimension="composition"),
                                   concept("band", "horizontal repeating band", dimension="composition")))
        self.assertNotIn("vertical stripes", result["negative_prompt"])

    def test_coordinated_negation_keeps_frame_suppression(self):
        result = self.preview(plan(concept("bird", "a single butterfly, no borders and frames")))
        self.assertIn("picture frame", result["negative_prompt"])
        self.assertIn("ornamental border", result["negative_prompt"])

    def test_negative_repeat_and_without_border_keep_positive_layout(self):
        for text in ("a single centered non-repeating butterfly", "a single centered butterfly without a border"):
            with self.subTest(text=text):
                result = self.preview(plan(concept("bird", text)))
                self.assertEqual(result["generation_policy"]["layout"], "focused")
                self.assertIn("repeating pattern", result["negative_prompt"])

    def test_realized_global_layout_uses_actual_accepted_english(self):
        value = plan(concept("butterfly", "butterfly"),
                     concept("center", "", dimension="composition", label="居中放置"))
        value["promptRealization"] = {"version": 1, "sourceFingerprint": plan_fingerprint(value), "model": "test",
            "groups": [{"rootId": "butterfly", "conceptIds": ["butterfly"], "text": "butterfly"},
                       {"rootId": "center", "conceptIds": ["center"], "text": "centered isolated composition"}]}
        result = self.preview(value)
        self.assertEqual(result["generation_policy"]["layout"], "focused")
        self.assertIn("repeating pattern", result["negative_prompt"])

    def test_over_budget_subject_stops_style_only_generation(self):
        value = plan(concept("long", "a very long subject condition that exceeds this test budget"),
                     concept("style", "embroidery", dimension="style"))
        tokenizer = Tokenizer()
        tokenizer.model_max_length = 6
        with self.assertRaisesRegex(ValueError, "主体条件未能完整编入"):
            self.preview(value, tokenizer)

    def test_requested_textile_and_photo_are_preserved(self):
        result = self.preview(plan(concept("rug", "photograph of a rug with a border")))
        self.assertNotIn("rug", result["negative_prompt"])
        self.assertNotIn("photograph", result["negative_prompt"])
        self.assertNotIn("ornamental border", result["negative_prompt"])

    def test_negative_budget_is_explicit_and_never_truncates_a_term(self):
        tokenizer = Tokenizer()
        tokenizer.model_max_length = 9
        result = self.preview(plan(concept()), tokenizer)
        policy = result["generation_policy"]
        self.assertLessEqual(policy["negative_token_count"], 9)
        self.assertTrue(policy["omitted_negative_terms"])
        self.assertEqual(result["negative_prompt"], ", ".join(policy["negative_terms"]))

    def test_omitted_border_does_not_affect_conditioning(self):
        value = plan(concept("butterfly", "butterfly", priority=3),
                     concept("frame", "very complex ornamental border with many repeated flowers", dimension="style", priority=1))
        tokenizer = Tokenizer()
        tokenizer.model_max_length = 6
        result = self.preview(value, tokenizer)
        self.assertIn("frame", result["omitted_concept_ids"])
        self.assertFalse(result["generation_policy"]["border_requested"])

    def test_accepted_realization_and_provenance_survive_profile_change(self):
        value = plan(concept("butterfly", "red butterfly", priority=3))
        value["promptRealization"] = {"version": 1, "sourceFingerprint": plan_fingerprint(value), "model": "test",
                                     "groups": [{"rootId": "butterfly", "conceptIds": ["butterfly"], "text": "red butterfly"}]}
        result = self.preview(value)
        self.assertEqual(result["prompt"], "red butterfly")
        self.assertIn("promptRealization", result["semantic_plan"])

    def test_invalid_profile_or_absent_plan_fails_before_inference(self):
        for payload in ({"generation_profile": "unknown"}, {"generation_profile": True},
                        {"generation_profile": "subject-fidelity"}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                service.generation_parameters(payload)

    def test_empty_subject_first_plan_requires_a_usable_condition(self):
        with self.assertRaisesRegex(ValueError, "可用英文条件"):
            self.preview(plan())


if __name__ == "__main__":
    unittest.main()

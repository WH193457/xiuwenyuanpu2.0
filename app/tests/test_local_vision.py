import base64
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

from local_vision import (
    REFERENCE_INSTRUCTION, TOBEST_FIELDS, VISION_PROMPT_VERSION,
    analyze_reference, decode_reference, extract_observations,
)


def encoded_image(size=(32, 32), mode="RGB", color="red"):
    buffer = io.BytesIO()
    Image.new(mode, size, color).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class LocalVisionTests(unittest.TestCase):
    def test_decodes_image_and_hashes_original_bytes(self):
        image, digest = decode_reference(encoded_image())
        self.assertEqual(image.size, (32, 32))
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(len(digest), 64)
        self.assertEqual(digest, decode_reference(encoded_image())[1])

    def test_transparent_pixels_use_white_background(self):
        image, _ = decode_reference(encoded_image(mode="RGBA", color=(255, 0, 0, 0)))
        self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))

    def test_invalid_data_is_rejected_before_loading_model(self):
        for value in (None, "https://example.com/image.png", "data:image/png;base64,abcd", "data:image/gif;base64,AAAA", encoded_image(size=(8, 32))):
            with self.subTest(value=str(value)[:60]), self.assertRaises(ValueError):
                decode_reference(value)

    def test_oversize_dimensions_rejected(self):
        with self.assertRaises(ValueError):
            decode_reference(encoded_image(size=(4001, 4000)))

    def test_observations_preserve_visual_scope_and_have_no_sources(self):
        raw = json.dumps({
            "subject": [{"label": "蝶形", "text": "butterfly-like silhouette"}],
            "palette": [{"label": "红蓝", "text": "red and blue"}],
            "intention": [{"label": "历史寓意", "text": "invented historical meaning"}],
        }, ensure_ascii=False)
        plan = extract_observations(raw, "REF-test")
        self.assertEqual(len(plan["concepts"]), 2)
        self.assertNotIn("intention", [item["dimension"] for item in plan["concepts"]])
        for item in plan["concepts"]:
            self.assertEqual(item["evidence"], "user")
            self.assertEqual(item["sourceIds"], [])
            self.assertEqual(item["patternIds"], [])

    def test_malformed_or_non_english_observations_rejected(self):
        for value in ("not JSON", "{}", '{"subject":[{"label":"蝶","text":"蝴蝶"}]}'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                extract_observations(value, "REF-test")

    def test_single_objects_and_english_strings_keep_model_text(self):
        raw = json.dumps({
            "subject": {"label": "卷曲轮廓", "text": "curled outlines"},
            "palette": "red and teal",
            "style": ["cut-out design"],
        }, ensure_ascii=False)
        concepts = extract_observations(raw, "REF-test")["concepts"]
        self.assertEqual([item["promptText"] for item in concepts], ["curled outlines", "red and teal", "cut-out design"])

    def test_nested_dimensions_are_recovered_without_inventing_fields(self):
        raw = json.dumps({"subject": {
            "text": "angular outlines", "composition": {"text": "diagonal arrangement"},
            "intention": {"text": "invented historical meaning"},
        }})
        concepts = extract_observations(raw, "REF-test")["concepts"]
        self.assertEqual([item["dimension"] for item in concepts], ["subject", "composition"])
        self.assertEqual([item["promptText"] for item in concepts], ["angular outlines", "diagonal arrangement"])

    def test_chinese_string_and_object_observations_are_rejected(self):
        for subject in ("只有中文主体", {"label": "轮廓", "text": "只有中文描述"}):
            with self.subTest(subject=subject), self.assertRaises(ValueError):
                extract_observations(json.dumps({"subject": subject}), "REF-test")

    def test_tobest_dimensions_map_to_editable_concepts_with_stable_ids(self):
        raw = json.dumps({
            "theme": "botanical design", "object": "a flower-like silhouette",
            "background": "plain ivory background", "emotion": "a calm visual mood",
            "style": "flat graphic treatment", "technique": "visible woven texture",
            "composition": "centered arrangement", "palette": "red and ivory",
        })
        plan = extract_observations(raw, "REF-tobest")
        concepts = {item["id"].split(":")[-2]: item for item in plan["concepts"]}
        self.assertEqual(set(concepts), {*TOBEST_FIELDS, "composition", "palette"})
        expected_dimensions = {
            "theme": "intention", "object": "subject", "background": "composition",
            "emotion": "intention", "style": "style", "technique": "technique",
            "composition": "composition", "palette": "palette",
        }
        for field, concept in concepts.items():
            self.assertEqual(concept["id"], f"vision:REF-tobest:{field}:0")
            self.assertEqual(concept["dimension"], expected_dimensions[field])
            self.assertEqual(concept["enabled"], field not in {"theme", "emotion"})
            self.assertEqual(concept["sourceIds"], [])
            self.assertEqual(concept["evidence"], "user")
        self.assertTrue(concepts["theme"]["label"].startswith("视觉主题建议 · "))
        self.assertTrue(concepts["emotion"]["label"].startswith("情绪建议 · "))
        self.assertEqual(concepts["object"]["priority"], 3)
        self.assertEqual(extract_observations(raw, "REF-tobest"), plan)

    def test_legacy_five_dimensions_keep_ids_and_enabled_state(self):
        raw = json.dumps({
            "subject": "curved silhouette", "composition": "central placement",
            "palette": "red", "style": "flat design", "technique": "rough visible texture",
        })
        concepts = extract_observations(raw, "REF-old")["concepts"]
        self.assertEqual([item["id"] for item in concepts], [
            f"vision:REF-old:{field}:0" for field in ("subject", "composition", "palette", "style", "technique")
        ])
        self.assertTrue(all(item["enabled"] for item in concepts))

    def test_empty_or_unobservable_tobest_fields_do_not_create_conditions(self):
        raw = json.dumps({
            "object": "curved angular silhouette", "theme": "unknown", "emotion": "unclear",
            "background": "not visually observable", "style": "", "technique": None,
            "composition": [], "palette": "N/A",
        })
        concepts = extract_observations(raw, "REF-empty")["concepts"]
        self.assertEqual(len(concepts), 1)
        self.assertEqual(concepts[0]["promptText"], "curved angular silhouette")

    def test_tobest_needs_a_visible_object_even_when_theme_exists(self):
        for value in ("", "unknown", "unknown object", "unclear", "not visible", "cannot be identified", [], None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                extract_observations(json.dumps({"object": value, "theme": "geometric design", "palette": "blue"}), "REF-empty")
        with self.assertRaises(ValueError):
            extract_observations(None, "REF-empty")

    def test_ambiguous_object_uses_the_observed_silhouette(self):
        concepts = extract_observations(json.dumps({"object": "an ambiguous curled silhouette", "emotion": ""}), "REF-shape")["concepts"]
        self.assertEqual(concepts[0]["promptText"], "an ambiguous curled silhouette")
        self.assertEqual(concepts[0]["dimension"], "subject")

    def test_tobest_analysis_persists_normalized_and_raw_observations(self):
        raw = json.dumps({
            "theme": "geometric design", "object": "an angular silhouette",
            "background": "white background", "emotion": "", "style": "flat design",
            "technique": "", "composition": "centered", "palette": "blue and white",
        })
        response = SimpleNamespace(returncode=0, stdout=json.dumps({"text": raw}), stderr="")
        with tempfile.TemporaryDirectory() as directory:
            with patch("local_vision.REFERENCE_DIRECTORY", Path(directory)), \
                    patch("local_vision.vision_available", return_value=True), \
                    patch("local_vision.subprocess.run", return_value=response) as worker:
                result = analyze_reference(encoded_image())
            worker.assert_called_once()
            self.assertEqual(result["observation_schema"], VISION_PROMPT_VERSION)
            self.assertEqual(result["raw_observation"], raw)
            self.assertEqual(set(result["tobest_observations"]), set(TOBEST_FIELDS))
            self.assertEqual(result["tobest_observations"]["emotion"], [])
            self.assertFalse(result["tobest_observations"]["theme"][0]["enabled"])
            self.assertEqual(result["tobest_observations"]["object"][0]["input_field"], "object")
            self.assertEqual(result["visual_extensions"]["palette"][0]["text"], "blue and white")
            saved = json.loads((Path(directory) / f'{result["reference"]["id"]}-analysis.json').read_text(encoding="utf-8"))
            self.assertEqual(saved, result)

    def test_worker_prompt_names_six_dimensions_and_local_example(self):
        for field in (*TOBEST_FIELDS, "composition", "palette"):
            self.assertIn(f'"{field}":', REFERENCE_INSTRUCTION)
        self.assertIn("locally authored example", REFERENCE_INSTRUCTION)
        self.assertIn("empty strings for unknown", REFERENCE_INSTRUCTION)
        self.assertIn("Do not infer ethnicity", REFERENCE_INSTRUCTION)


if __name__ == "__main__":
    unittest.main()

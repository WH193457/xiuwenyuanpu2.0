import copy
import unittest

from prompt_plan import compile_plan, validate_plan
from local_language import parse_refinement
from semantic_checks import inspect_plan
from structure_metrics import structure_metrics
from test_semantic_generation import concept, plan, Tokenizer


class ContextAndProvenanceTests(unittest.TestCase):
    def test_duplicate_service_cannot_bind_same_port(self):
        from lora_service import LocalThreadingHTTPServer, Handler
        with LocalThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            with self.assertRaises(OSError):
                with LocalThreadingHTTPServer(server.server_address, Handler):
                    pass

    def fixture(self):
        value = plan(concept("butterfly", "butterfly"))
        value["context"] = {"goal": "minimal", "algorithm": "context-walk-v1", "brief": "蝴蝶",
            "focusConceptIds": ["butterfly"], "excludedConceptIds": ["style:高对比"]}
        value["concepts"][0]["annotations"] = [{"patternId": "DX017", "field": "main_elements", "value": "蝴蝶",
            "sourceIds": ["S01"], "evidence": "visual"}]
        value["concepts"][0]["recommendation"] = {"algorithm": "context-walk-v1", "goal": "minimal",
            "nodes": ["pattern:DX017", "subject:蝴蝶"], "relations": [["main_elements"]],
            "sourceIds": ["S01"], "factors": ["简洁文创"]}
        return value

    def test_context_and_original_evidence_survive_compilation(self):
        original = self.fixture()
        result = compile_plan(original, Tokenizer())
        self.assertEqual(result["semantic_plan"], original)
        self.assertNotIn("简洁文创", result["prompt"])
        self.assertEqual(result["prompt"], "dongzu, butterfly")

    def test_language_refinement_preserves_recorded_provenance(self):
        original = self.fixture()
        refined = parse_refinement('{"translations":[{"id":"butterfly","promptText":"paired butterflies"}],"extraPrompt":""}', original, "")
        self.assertEqual(refined["context"], original["context"])
        self.assertEqual(refined["concepts"][0]["annotations"], original["concepts"][0]["annotations"])
        self.assertEqual(refined["concepts"][0]["recommendation"], original["concepts"][0]["recommendation"])

    def test_invalid_context_rejected(self):
        for field, value in [("goal", "unrecognized"), ("algorithm", "magic"), ("brief", "x" * 601), ("focusConceptIds", ["x"] * 257)]:
            request = self.fixture()
            request["context"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_plan(request)

    def test_malformed_annotation_and_path_rejected(self):
        request = self.fixture()
        request["concepts"][0]["annotations"][0]["field"] = "invented"
        with self.assertRaises(ValueError):
            validate_plan(request)
        request = self.fixture()
        request["concepts"][0]["recommendation"]["relations"] = []
        with self.assertRaises(ValueError):
            validate_plan(request)

    def test_layout_conflict_is_scope_aware(self):
        value = plan(concept("a", "isolated single motif", dimension="composition"),
                     concept("b", "all-over repeating pattern", dimension="composition"))
        self.assertIn("composition-conflict", [item["code"] for item in inspect_plan(value)])
        value["concepts"] += [concept("one"), concept("two")]
        value["concepts"][0]["parentId"] = "one"
        value["concepts"][1]["parentId"] = "two"
        self.assertNotIn("composition-conflict", [item["code"] for item in inspect_plan(value)])

    def test_disabled_conditions_do_not_trigger_conflicts(self):
        value = plan(concept("a", "bilateral symmetry", dimension="composition"),
                     concept("b", "loose asymmetry", dimension="composition", enabled=False))
        self.assertEqual(inspect_plan(value), [])

    def test_no_cultural_correctness_assertion(self):
        value = plan(concept("culture", "harmony", dimension="intention", evidence="cautious"))
        before = copy.deepcopy(value)
        checks = inspect_plan(value)
        self.assertEqual(checks[0]["code"], "interpretation-needs-review")
        self.assertEqual(checks[0]["severity"], "info")
        self.assertEqual(value, before)

    def test_missing_source_and_token_omissions_are_exposed(self):
        value = plan(concept("culture", "harmony", dimension="intention", evidence="supported"),
                     concept("long", "word " * 90))
        codes = {item["code"] for item in compile_plan(value, Tokenizer())["plan_checks"]}
        self.assertIn("missing-cultural-source", codes)
        self.assertIn("omitted-condition", codes)


class StructureMetricTests(unittest.TestCase):
    def setUp(self):
        from PIL import Image, ImageDraw
        self.image = Image.new("RGB", (128, 128), "white")
        draw = ImageDraw.Draw(self.image)
        draw.rectangle((24, 24, 103, 103), fill="red")
        self.plan = plan(concept("mirror", "bilateral symmetry", dimension="composition"))

    def test_symmetric_and_asymmetric_pixels(self):
        from PIL import ImageDraw
        symmetric = structure_metrics(self.image, self.plan, ["mirror"])[0]
        self.assertEqual(symmetric["score"], 1)
        self.assertTrue(symmetric["reliable"])
        ImageDraw.Draw(self.image).rectangle((0, 0, 50, 127), fill="black")
        asymmetric = structure_metrics(self.image, self.plan, ["mirror"])[0]
        self.assertLess(asymmetric["score"], symmetric["score"])

    def test_omitted_and_subject_local_conditions_are_not_scored(self):
        self.assertEqual(structure_metrics(self.image, self.plan, []), [])
        self.plan["concepts"].append(concept("subject"))
        self.plan["concepts"][0]["parentId"] = "subject"
        self.assertEqual(structure_metrics(self.image, self.plan, ["mirror"]), [])

    def test_plain_images_flagged_unreliable(self):
        from PIL import Image
        metric = structure_metrics(Image.new("RGB", (128, 128), "white"), self.plan, ["mirror"])[0]
        self.assertFalse(metric["reliable"])

    def test_general_rotation_does_not_assume_half_turn(self):
        value = plan(concept("rotation", "rotational symmetry", dimension="composition"))
        self.assertEqual(structure_metrics(self.image, value, ["rotation"]), [])

    def test_seams_and_half_turn_are_measured_when_requested(self):
        value = plan(concept("tile", "seamless pattern", dimension="composition"),
                     concept("rotation", "180 degree rotational symmetry", dimension="composition"))
        metrics = structure_metrics(self.image, value, ["tile", "rotation"])
        self.assertEqual({metric["kind"] for metric in metrics}, {"tile_edges", "rotate_180"})
        self.assertTrue(all(metric["score"] == 1 for metric in metrics))


if __name__ == "__main__":
    unittest.main()

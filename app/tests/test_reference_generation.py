"""Reference service integration checks using real CPU preparation and fake diffusion."""

import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from PIL import Image, ImageDraw

import lora_service as service
import reference_conditioning as references
from test_semantic_generation import FakeTorch, Tokenizer, concept, plan


def fixture_image():
    image = Image.new("RGBA", (80, 64), "white")
    ImageDraw.Draw(image).ellipse((15, 12, 64, 51), fill=(20, 50, 90, 255))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


class ReferencePipeline:
    device = "cpu"
    tokenizer = Tokenizer()

    def __init__(self, fail_after=None, fail_adapter=False):
        self.calls = []
        self.adapter_weights = []
        self.fail_after = fail_after
        self.fail_adapter = fail_adapter

    def set_adapters(self, name, adapter_weights):
        self.adapter_weights.append((name, adapter_weights))
        if self.fail_adapter and adapter_weights != 1.0:
            raise RuntimeError("fixture adapter failure")

    def __call__(self, **kwargs):
        if self.fail_after is not None and len(self.calls) >= self.fail_after:
            raise RuntimeError("fixture diffusion failure")
        self.calls.append(kwargs)
        callback = kwargs.get("callback_on_step_end")
        if callback:
            for index in range(int(kwargs["num_inference_steps"] * kwargs["strength"])):
                values = {"latents": "fixture-latents"}
                if callback(self, index, index, values) is not values:
                    raise AssertionError("Step-count callback must preserve inference values")
        image = Image.new("RGB", (kwargs["width"], kwargs["height"]), "#235681")
        return SimpleNamespace(images=[image])


class ReferenceGenerationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.root = Path(temporary.name)
        self.addCleanup(temporary.cleanup)
        for name, value, module in (("CONTROL_ROOT", self.root / "controls", references),
                                    ("OUTPUT_ROOT", self.root / "generated", service),
                                    ("cached_tokenizer", Mock(return_value=Tokenizer()), service),
                                    ("TORCH", FakeTorch, service)):
            replacement = patch.object(module, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.prepared = service.prepare_reference({"image_data_url": fixture_image(),
            "palette_mode": "solid", "foreground_color": "#3050C0", "background_color": "#F5EEDC"})

    def configuration(self, **changes):
        return {"method": "canny-img2img", "reference_id": self.prepared["reference_id"],
            "reference_sha256": self.prepared["reference_sha256"], "strength": 0.6,
            "control_scale": 0.75, "embroidery_detail": True, **changes}

    def payload(self, **changes):
        return {"semantic_plan": plan(concept(text="single blue butterfly")), "generation_profile": "subject-fidelity",
            "reference_conditioning": self.configuration(), "pattern_id": "DX001", "seed": 0,
            "count": 2, "steps": 30, "lora_scale": 0.35, **changes}

    def test_preview_and_generation_use_identical_conditioning_and_saved_pixels(self):
        pipeline = ReferencePipeline()
        payload = self.payload()
        preview = service.preview(payload)
        with patch.object(service, "load_reference_pipeline", return_value=pipeline) as loader, \
                patch.object(service, "load_pipeline") as ordinary_loader:
            generated = service.generate(payload)
        loader.assert_called_once_with("canny-img2img")
        ordinary_loader.assert_not_called()
        for field in ("prompt", "negative_prompt", "prompt_token_count", "texture_prompt", "semantic_plan",
                      "reference_conditioning", "reference_preparation", "generation_policy"):
            self.assertEqual(generated[field], preview[field], field)
        self.assertEqual(generated["conditioning_model"], {"name": service.CONTROLNET_NAME, "revision": service.CONTROLNET_REVISION})
        self.assertEqual(generated["postprocessing"], "none")
        self.assertEqual([item["denoisingSteps"] for item in generated["candidates"]], [18, 18])
        self.assertEqual([item["seed"] for item in generated["candidates"]], [0, 1])
        self.assertEqual(pipeline.adapter_weights, [(service.ADAPTER_NAME, 0.35), (service.ADAPTER_NAME, 1.0)])
        loaded = references.load_reference_conditioning(self.configuration())
        for call in pipeline.calls:
            self.assertEqual(call["image"].tobytes(), loaded["image"].tobytes())
            self.assertEqual(call["control_image"].tobytes(), loaded["control_image"].tobytes())
            self.assertEqual(call["controlnet_conditioning_scale"], 0.75)
            self.assertEqual(call["strength"], 0.6)
        directory = Path(generated["metadata_path"]).parent
        saved = json.loads(Path(generated["metadata_path"]).read_text(encoding="utf-8"))
        self.assertEqual(saved["reference_preparation"], loaded["metadata"])
        self.assertEqual(saved["status"], "complete")
        self.assertNotIn("base64", json.dumps(saved))
        for kind in ("init", "mask", "control"):
            raw = (directory / f"reference-{kind}.png").read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), loaded["metadata"]["files"][kind]["sha256"])
        for candidate in generated["candidates"]:
            with Image.open(candidate["path"]) as image:
                self.assertEqual(image.format, "PNG")
                self.assertEqual(image.size, (512, 512))
        self.assertEqual(service.ACTIVE_TASK, None)
        self.assertEqual(service.QUEUED_TASKS, 0)

    def test_img2img_route_omits_controlnet_arguments_and_records_actual_steps(self):
        pipeline = ReferencePipeline()
        config = self.configuration(method="img2img", strength=0.4, embroidery_detail=False)
        with patch.object(service, "load_reference_pipeline", return_value=pipeline) as loader:
            generated = service.generate(self.payload(reference_conditioning=config))
        loader.assert_called_once_with("img2img")
        self.assertIsNone(generated["conditioning_model"])
        self.assertNotIn("texture_prompt", generated)
        self.assertEqual([item["denoisingSteps"] for item in generated["candidates"]], [12, 12])
        for call in pipeline.calls:
            self.assertNotIn("control_image", call)
            self.assertNotIn("controlnet_conditioning_scale", call)
            self.assertIn("image", call)

    def test_texture_detail_fits_budget_and_does_not_negate_requested_photography(self):
        for profile in ("standard", "subject-fidelity"):
            with self.subTest(profile=profile):
                result = service.preview(self.payload(generation_profile=profile))
                self.assertIn(service.EMBROIDERY_PROMPT, result["prompt"])
                self.assertEqual(result["prompt_token_count"], len(result["prompt"].split()) + 2)
                self.assertLessEqual(result["prompt_token_count"], result["token_limit"])
                terms = result["negative_prompt"].split(", ")
                self.assertNotIn("photo", terms)
                self.assertNotIn("photograph", terms)
                self.assertEqual(result["semantic_plan"], self.payload()["semantic_plan"])
        short_tokenizer = Tokenizer()
        short_tokenizer.model_max_length = 9
        with patch.object(service, "cached_tokenizer", return_value=short_tokenizer), \
                patch.object(service, "load_reference_pipeline") as loader:
            with self.assertRaisesRegex(ValueError, "质感描述超出"):
                service.generate(self.payload())
            loader.assert_not_called()

    def test_disabling_texture_preserves_existing_prompt_and_negative(self):
        for profile in ("standard", "subject-fidelity"):
            payload = self.payload(generation_profile=profile)
            payload.pop("reference_conditioning")
            baseline = service.preview(payload)
            conditioned = service.preview({**payload, "reference_conditioning": self.configuration(embroidery_detail=False)})
            self.assertEqual(conditioned["prompt"], baseline["prompt"])
            self.assertEqual(conditioned["negative_prompt"], baseline["negative_prompt"])
        legacy = {"pattern_id": "DX001", "pattern_name": "蝴蝶", "seed": 0, "count": 2}
        expected = service.build_prompt(legacy)
        preview = service.preview(legacy)
        self.assertEqual((preview["prompt"], preview["negative_prompt"]), expected)
        self.assertNotIn("reference_conditioning", preview)
        pipeline = ReferencePipeline()
        with patch.object(service, "load_pipeline", return_value=pipeline), \
                patch.object(service, "load_reference_pipeline") as reference_loader:
            generated = service.generate(legacy)
        reference_loader.assert_not_called()
        self.assertEqual((generated["prompt"], generated["negative_prompt"]), expected)
        self.assertNotIn("denoisingSteps", generated["candidates"][0])
        for call in pipeline.calls:
            self.assertNotIn("image", call)
            self.assertNotIn("strength", call)

    def test_prepared_dimensions_are_used_and_explicit_mismatch_fails_before_loading(self):
        self.prepared = service.prepare_reference({"image_data_url": fixture_image(), "width": 384, "height": 640})
        pipeline = ReferencePipeline()
        with patch.object(service, "load_reference_pipeline", return_value=pipeline):
            generated = service.generate(self.payload())
        self.assertEqual((generated["width"], generated["height"]), (384, 640))
        with patch.object(service, "load_reference_pipeline") as loader:
            with self.assertRaisesRegex(ValueError, "尺寸不同"):
                service.generate(self.payload(width=512, height=512))
            loader.assert_not_called()

    def test_preview_rejects_a_dimension_mismatch_just_like_generation(self):
        self.prepared = service.prepare_reference({"image_data_url": fixture_image(), "width": 384, "height": 640})
        with patch.object(service, "load_reference_pipeline") as loader:
            with self.assertRaisesRegex(ValueError, "尺寸不同"):
                service.preview(self.payload(width=512, height=512))
            loader.assert_not_called()

    def test_invalid_or_modified_reference_fails_before_any_model_loading(self):
        invalid_payloads = [self.payload(reference_conditioning=self.configuration(reference_sha256="f" * 64)),
                            self.payload(reference_conditioning=self.configuration(strength=0.1)),
                            {"reference_conditioning": self.configuration()}]
        for payload in invalid_payloads:
            with self.subTest(payload=payload), patch.object(service, "load_pipeline") as base, \
                    patch.object(service, "load_reference_pipeline") as conditioned:
                with self.assertRaises(ValueError):
                    service.generate(payload)
                base.assert_not_called()
                conditioned.assert_not_called()
        init = self.root / "controls" / self.prepared["reference_id"] / "init.png"
        init.write_bytes(init.read_bytes() + b"modified")
        with patch.object(service, "load_reference_pipeline") as conditioned, self.assertRaises(ValueError):
            service.generate(self.payload())
        conditioned.assert_not_called()

    def test_partial_reference_generation_failure_records_progress_and_resets_adapter(self):
        for pipeline in (ReferencePipeline(fail_after=1), ReferencePipeline(fail_adapter=True)):
            with self.subTest(adapter_failure=pipeline.fail_adapter), \
                    patch.object(service, "load_reference_pipeline", return_value=pipeline):
                before = set((self.root / "generated").glob("*/generation.json"))
                with self.assertRaisesRegex(RuntimeError, "fixture"):
                    service.generate(self.payload())
                paths = set((self.root / "generated").glob("*/generation.json")) - before
                self.assertEqual(len(paths), 1)
                saved = json.loads(paths.pop().read_text(encoding="utf-8"))
                self.assertEqual(saved["status"], "failed")
                self.assertEqual(len(saved["candidates"]), 0 if pipeline.fail_adapter else 1)
                self.assertEqual(saved["reference_conditioning"], self.configuration())
                self.assertEqual(pipeline.adapter_weights[-1], (service.ADAPTER_NAME, 1.0))
                self.assertEqual(service.ACTIVE_TASK, None)
                self.assertEqual(service.QUEUED_TASKS, 0)

    def test_failed_reference_snapshot_is_recorded_before_inference(self):
        pipeline = ReferencePipeline()
        original_save = Image.Image.save

        def save_with_failure(image, destination, *args, **kwargs):
            if isinstance(destination, (str, Path)) and Path(destination).name == "reference-control.png":
                raise OSError("fixture reference snapshot write failure")
            return original_save(image, destination, *args, **kwargs)

        with patch.object(service, "load_reference_pipeline", return_value=pipeline), \
                patch.object(Image.Image, "save", save_with_failure):
            with self.assertRaisesRegex(OSError, "snapshot write"):
                service.generate(self.payload())
        records = list((self.root / "generated").glob("*/generation.json"))
        self.assertEqual(len(records), 1, "A failed reference snapshot needs a persisted failure record")
        saved = json.loads(records[0].read_text(encoding="utf-8"))
        self.assertEqual(saved["status"], "failed")
        self.assertIn("snapshot write failure", saved["error"])
        self.assertEqual(saved["candidates"], [])
        self.assertEqual(pipeline.calls, [])
        self.assertEqual(service.ACTIVE_TASK, None)

    def test_http_prepare_preview_generate_and_invalid_requests(self):
        server = service.LocalThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        opener = build_opener(ProxyHandler({}))

        def post(endpoint, payload):
            request = Request(f"http://127.0.0.1:{server.server_port}/api/lora/{endpoint}",
                data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
            with opener.open(request, timeout=10) as response:
                return json.load(response)

        try:
            pipeline = ReferencePipeline()
            with patch.object(service, "load_reference_pipeline", return_value=pipeline) as conditioned, \
                    patch.object(service, "load_pipeline") as ordinary:
                # Preparation uses the image-upload limit, unlike ordinary JSON preview.
                self.prepared = post("prepare-reference", {"image_data_url": fixture_image(), "padding": "x" * 300_000})
                preview = post("preview", self.payload())
                ordinary.assert_not_called()
                conditioned.assert_not_called()
                generated = post("generate", self.payload())
                self.assertEqual(generated["prompt"], preview["prompt"])
                self.assertEqual(generated["reference_preparation"], preview["reference_preparation"])
                for endpoint, payload in (("prepare-reference", {"image_data_url": "invalid"}),
                                          ("prepare-reference", {"pattern_id": "../../secret"}),
                                          ("preview", self.payload(reference_conditioning={"method": "img2img"})),
                                          ("generate", self.payload(reference_conditioning=self.configuration(control_scale=-1)))):
                    with self.subTest(endpoint=endpoint), self.assertRaises(HTTPError) as error:
                        post(endpoint, payload)
                    self.assertEqual(error.exception.code, 400)
                self.assertEqual(conditioned.call_count, 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


class ReferencePipelineLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.base = SimpleNamespace(device="cpu", unet=SimpleNamespace(dtype="fixture-dtype"))
        self.image_wrapper = Mock(name="image-wrapper")
        self.control_wrapper = Mock(name="control-wrapper")
        self.controlnet = Mock(name="controlnet")
        self.module = ModuleType("diffusers")
        self.module.StableDiffusionImg2ImgPipeline = SimpleNamespace(from_pipe=Mock(return_value=self.image_wrapper))
        self.module.StableDiffusionControlNetImg2ImgPipeline = SimpleNamespace(from_pipe=Mock(return_value=self.control_wrapper))
        self.module.ControlNetModel = SimpleNamespace(from_pretrained=Mock(return_value=self.controlnet))
        changes = [patch.dict(sys.modules, {"diffusers": self.module}), patch.object(service, "PIPE", self.base),
            patch.object(service, "IMAGE_PIPE", None), patch.object(service, "CONTROL_PIPE", None),
            patch.object(service, "controlnet_available", return_value=True),
            patch.object(service, "TORCH", SimpleNamespace(cuda=SimpleNamespace(is_available=Mock(return_value=True), empty_cache=Mock()))),
            patch.object(service, "MODEL_STATE", "ready"), patch.object(service, "MODEL_ERROR", "fixture-old-error")]
        for change in changes:
            change.start()
            self.addCleanup(change.stop)

    def test_wrappers_reuse_base_components_and_are_cached_until_unload(self):
        self.assertIs(service.load_reference_pipeline("img2img"), self.image_wrapper)
        self.assertIs(service.load_reference_pipeline("img2img"), self.image_wrapper)
        self.assertIs(service.load_reference_pipeline("canny-img2img"), self.control_wrapper)
        self.assertIs(service.load_reference_pipeline("canny-img2img"), self.control_wrapper)
        self.module.StableDiffusionImg2ImgPipeline.from_pipe.assert_called_once_with(self.base)
        self.module.StableDiffusionControlNetImg2ImgPipeline.from_pipe.assert_called_once_with(self.base, controlnet=self.controlnet)
        args = self.module.ControlNetModel.from_pretrained.call_args
        self.assertTrue(args.kwargs["local_files_only"])
        self.assertTrue(args.kwargs["use_safetensors"])
        self.assertEqual(args.kwargs["torch_dtype"], "fixture-dtype")
        self.controlnet.to.assert_called_once_with("cpu")
        service.unload_pipeline()
        self.assertIsNone(service.PIPE)
        self.assertIsNone(service.IMAGE_PIPE)
        self.assertIsNone(service.CONTROL_PIPE)
        self.assertEqual(service.MODEL_STATE, "cold")
        self.assertIsNone(service.MODEL_ERROR)
        service.TORCH.cuda.empty_cache.assert_called_once()
        replacement = SimpleNamespace(device="cpu", unet=SimpleNamespace(dtype="new-dtype"))
        with patch.object(service, "PIPE", replacement):
            service.load_reference_pipeline("img2img")
        self.assertEqual(self.module.StableDiffusionImg2ImgPipeline.from_pipe.call_count, 2)
        self.assertIs(self.module.StableDiffusionImg2ImgPipeline.from_pipe.call_args.args[0], replacement)

    def test_missing_controlnet_keeps_img2img_usable(self):
        with patch.object(service, "controlnet_available", return_value=False):
            self.assertIs(service.load_reference_pipeline("img2img"), self.image_wrapper)
            with self.assertRaisesRegex(FileNotFoundError, "ControlNet"):
                service.load_reference_pipeline("canny-img2img")
        self.assertIsNone(service.CONTROL_PIPE)
        self.assertIs(service.PIPE, self.base)
        self.module.ControlNetModel.from_pretrained.assert_not_called()

    def test_failed_wrapper_construction_leaves_no_partial_cache_and_can_retry(self):
        factory = self.module.StableDiffusionControlNetImg2ImgPipeline.from_pipe
        factory.side_effect = RuntimeError("fixture constructor failure")
        with self.assertRaisesRegex(RuntimeError, "constructor"):
            service.load_reference_pipeline("canny-img2img")
        self.assertIsNone(service.CONTROL_PIPE)
        self.assertIs(service.PIPE, self.base)
        factory.side_effect = None
        self.assertIs(service.load_reference_pipeline("canny-img2img"), self.control_wrapper)
        self.assertEqual(factory.call_count, 2)


if __name__ == "__main__":
    unittest.main()

"""CPU regression checks for immutable image-conditioning references."""

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

import reference_conditioning as references
from embroidery_material import MATERIAL_VERSION, NOISE_SEED, materialize


def data_url(image, format="PNG"):
    buffer = io.BytesIO()
    image.save(buffer, format=format)
    mime = "jpeg" if format == "JPEG" else format.lower()
    return f"data:image/{mime};base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def silhouette():
    image = Image.new("RGBA", (120, 80), "white")
    ImageDraw.Draw(image).rectangle((20, 20, 99, 59), fill=(40, 60, 100, 255))
    return image


class ReferenceConditioningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.output_patch = patch.object(references, "CONTROL_ROOT", self.root / "controls")
        self.output_patch.start()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.output_patch.stop)

    def prepare(self, image=None, **settings):
        return references.prepare_reference({"image_data_url": data_url(image if image is not None else silhouette()), **settings})

    def load(self, prepared, **settings):
        return references.load_reference_conditioning({"method": "canny-img2img",
            "reference_id": prepared["reference_id"], "reference_sha256": prepared["reference_sha256"], **settings})

    def test_prepare_load_round_trip_and_bound_hashes(self):
        prepared = self.prepare()
        loaded = self.load(prepared, embroidery_detail=True)
        self.assertEqual(loaded["image"].size, (512, 512))
        self.assertEqual(loaded["control_image"].mode, "RGB")
        self.assertEqual(loaded["mask_image"].mode, "L")
        self.assertEqual(loaded["strength"], 0.55)
        self.assertTrue(loaded["embroidery_detail"])
        self.assertEqual(loaded["metadata"]["settings"], prepared["settings"])
        self.assertEqual(loaded["metadata"]["reference_sha256"], prepared["reference_sha256"])
        self.assertEqual(set(loaded["metadata"]["files"]), {"source", "mask", "init", "control"})
        for kind, value in (("init", "init_image"), ("mask", "mask_image"), ("control", "control_image")):
            raw = base64.b64decode(prepared[value].split(",", 1)[1])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), loaded["metadata"]["files"][kind]["sha256"])

    def test_centered_and_band_preserve_aspect_and_margins(self):
        centered = self.load(self.prepare())
        band = self.load(self.prepare(layout="horizontal-band"))
        for result in (centered, band):
            x0, y0, x1, y1 = result["mask_image"].getbbox()
            self.assertAlmostEqual((x1 - x0) / (y1 - y0), 2, delta=0.03)
            self.assertAlmostEqual((x0 + x1) / 2, 256, delta=1)
            self.assertAlmostEqual((y0 + y1) / 2, 256, delta=1)
            self.assertGreaterEqual(min(x0, y0, 512 - x1, 512 - y1), 60)
        tall = Image.new("RGB", (60, 160), "white")
        ImageDraw.Draw(tall).rectangle((20, 10, 39, 149), fill="black")
        bounds = self.load(self.prepare(tall, layout="horizontal-band"))["mask_image"].getbbox()
        self.assertLessEqual(bounds[3] - bounds[1], int(512 * 0.45))

    def test_preserve_keeps_source_spatial_position(self):
        image = Image.new("RGB", (100, 100), "white")
        ImageDraw.Draw(image).rectangle((5, 30, 24, 49), fill="black")
        centered = self.load(self.prepare(image))["mask_image"].getbbox()
        preserved = self.load(self.prepare(image, layout="preserve"))["mask_image"].getbbox()
        self.assertAlmostEqual((centered[0] + centered[2]) / 2, 256, delta=1)
        self.assertLess((preserved[0] + preserved[2]) / 2, 160)

    def test_crop_excludes_an_outer_photo_frame_without_erasing_subject_lines(self):
        image = Image.new("RGB", (100, 100), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((2, 2, 97, 97), outline="black", width=5)
        draw.rectangle((30, 40, 69, 59), fill="black")
        prepared = self.prepare(image, crop=[0.2, 0.2, 0.8, 0.8])
        loaded = self.load(prepared)
        mask = np.array(loaded["mask_image"])
        self.assertGreater(mask[256, 256], 250)
        self.assertEqual(mask[100, 256], 0)
        self.assertGreater(np.count_nonzero(np.array(loaded["control_image"])), 0)
        self.assertEqual(prepared["source"]["width"], 100)

    def test_transparency_limits_every_mask_and_alpha_preserves_partial_opacity(self):
        image = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((20, 30, 59, 49), fill=(20, 40, 70, 100))
        for mode in ("dark", "alpha"):
            with self.subTest(mode=mode):
                loaded = self.load(self.prepare(image, mask_mode=mode))
                values = np.array(loaded["mask_image"])
                self.assertEqual(values[0, 0], 0)
                self.assertAlmostEqual(int(values[256, 256]), 100, delta=1)
                self.assertLess(values.max(), 150)

    def test_light_and_saturation_masks(self):
        image = Image.new("RGB", (100, 100), (30, 30, 30))
        ImageDraw.Draw(image).rectangle((30, 30, 69, 69), fill="white")
        self.assertGreater(np.array(self.load(self.prepare(image, mask_mode="light"))["mask_image"])[256, 256], 0)
        image = Image.new("RGB", (100, 100), "white")
        ImageDraw.Draw(image).rectangle((30, 30, 69, 69), fill="red")
        prepared = self.prepare(image, mask_mode="saturated")
        self.assertEqual(prepared["settings"]["threshold"], 80)
        self.assertGreater(np.array(self.load(prepared)["mask_image"])[256, 256], 0)

    def test_source_palette_retains_subject_and_changes_background(self):
        loaded = self.load(self.prepare(background_color="#ABCDEF"))
        self.assertEqual(loaded["image"].getpixel((0, 0)), (171, 205, 239))
        self.assertEqual(loaded["image"].getpixel((256, 256)), (40, 60, 100))

    def test_solid_palette_retains_high_frequency_luminance(self):
        pixels = np.full((80, 80, 4), 255, dtype=np.uint8)
        pixels[20:60, 20:60, :3] = 80
        pixels[20:60:2, 20:60, :3] = 160
        loaded = self.load(self.prepare(Image.fromarray(pixels), palette_mode="solid", foreground_color="#3070C0"))
        rgb = np.array(loaded["image"])[200:310, 200:310]
        self.assertGreater(float(rgb[:, :, 2].mean()), float(rgb[:, :, 0].mean()) + 80)
        self.assertGreater(float(rgb[:, :, 0].std()), 3)

    def test_invalid_settings_empty_mask_and_source_fail_before_publication(self):
        invalid = [{"crop": [0.7, 0, 0.2, 1]}, {"crop": [0, 0, 2, 1]}, {"crop": [0, 0, float("nan"), 1]},
                   {"crop": [0, 0, 0.001, 0.001]}, {"threshold": 256}, {"threshold": True}, {"margin": 0.01},
                   {"width": 513}, {"height": 1024}, {"foreground_color": "red"}, {"layout": "stretch"},
                   {"mask_mode": "unknown"}, {"palette_mode": "unknown"}, {"texture_mode": "unknown"}]
        for settings in invalid:
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                self.prepare(**settings)
        with self.assertRaisesRegex(ValueError, "未选中"):
            self.prepare(Image.new("RGB", (32, 32), "white"))
        with self.assertRaisesRegex(ValueError, "至少16"):
            self.prepare(Image.new("RGB", (8, 8), "black"))
        with patch.object(references, "MAX_IMAGE_PIXELS", 10), self.assertRaisesRegex(ValueError, "总像素"):
            self.prepare()
        with self.assertRaises(ValueError):
            references.prepare_reference({"image_data_url": "file:///secret.png"})
        self.assertFalse((self.root / "controls").exists())

    def test_exif_orientation_is_applied_before_crop(self):
        image = Image.new("RGB", (40, 80), "black")
        exif = Image.Exif()
        exif[274] = 6
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", exif=exif)
        prepared = references.prepare_reference({"image_data_url": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")})
        self.assertEqual((prepared["source"]["width"], prepared["source"]["height"]), (80, 40))
        with Image.open(self.root / "controls" / prepared["reference_id"] / "source.png") as normalized:
            self.assertEqual(dict(normalized.getexif()), {})

    def test_canonical_mapping_reads_registered_source_and_preserves_original(self):
        canonical = self.root / "canonical"
        (canonical / "03_标注数据").mkdir(parents=True)
        (canonical / "01_编号图像").mkdir()
        original = canonical / "01_编号图像" / "DX001.png"
        silhouette().save(original)
        source_bytes = original.read_bytes()
        (canonical / "03_标注数据" / "patterns.json").write_text(json.dumps([
            {"id": "DX001", "name": "Fixture", "image": "01_编号图像/DX001.png"}]), encoding="utf-8")
        (canonical / "03_标注数据" / "elements.json").write_text(json.dumps([
            {"id": "DXE001", "name": "Crop fixture", "pattern_id": "DX001", "image": "01_编号图像/DX001.png"}]), encoding="utf-8")
        with patch.object(references, "CANONICAL_ROOT", canonical):
            for field, identifier in (("pattern_id", "DX001"), ("element_id", "DXE001")):
                result = references.prepare_reference({field: identifier})
                self.assertEqual(result["source"]["id"], identifier)
                self.assertEqual(result["source"]["sha256"], hashlib.sha256(source_bytes).hexdigest())
                self.load(result)
            for payload in ({"pattern_id": "../DX001"}, {"pattern_id": "DX999"},
                            {"pattern_id": "DX001", "element_id": "DXE001"}):
                with self.assertRaises(ValueError):
                    references.prepare_reference(payload)
        self.assertEqual(original.read_bytes(), source_bytes)

    def test_canonical_mapping_cannot_escape_its_registered_directory(self):
        canonical = self.root / "canonical"
        (canonical / "03_标注数据").mkdir(parents=True)
        silhouette().save(self.root / "outside.png")
        (canonical / "03_标注数据" / "patterns.json").write_text(json.dumps([
            {"id": "DX001", "name": "Invalid fixture", "image": "../outside.png"}]), encoding="utf-8")
        with patch.object(references, "CANONICAL_ROOT", canonical), self.assertRaisesRegex(ValueError, "超出资料目录"):
            references.prepare_reference({"pattern_id": "DX001"})

    def test_actual_canonical_pattern_and_element_use_the_same_public_entrypoint(self):
        catalogue = references.CANONICAL_ROOT / "03_标注数据" / "patterns.json"
        if not catalogue.exists():
            self.skipTest("Canonical handoff data is unavailable in this environment")
        for field, identifier in (("pattern_id", "DX001"), ("element_id", "DXE012")):
            with self.subTest(identifier=identifier):
                prepared = references.prepare_reference({field: identifier})
                result = self.load(prepared)
                self.assertEqual(result["metadata"]["source"]["id"], identifier)
                self.assertIsNotNone(result["mask_image"].getbbox())

    def test_changed_settings_get_a_new_content_hash_without_overwriting_prior_reference(self):
        before = self.prepare()
        after = self.prepare(background_color="#0000FF", palette_mode="solid", foreground_color="#FF0000")
        self.assertNotEqual(before["reference_sha256"], after["reference_sha256"])
        self.assertNotEqual(before["reference_id"], after["reference_id"])
        self.assertEqual(self.load(before)["metadata"]["settings"], before["settings"])

    def test_oversized_upload_and_malformed_base64_are_rejected(self):
        with patch.object(references, "MAX_IMAGE_BYTES", 10), self.assertRaisesRegex(ValueError, "超过8MB"):
            self.prepare()
        with self.assertRaisesRegex(ValueError, "编码无效"):
            references.prepare_reference({"image_data_url": "data:image/png;base64,A"})

    def test_opaque_alpha_mode_warns_and_keeps_legitimate_full_field_structure(self):
        prepared = self.prepare(mask_mode="alpha")
        self.assertTrue(any("没有透明区域" in warning for warning in prepared["warnings"]))
        self.assertIsNotNone(self.load(prepared)["control_image"].getbbox())

    def test_hashes_detect_changes_to_every_png_and_preprocessing_settings(self):
        for name in references.ARTIFACT_NAMES.values():
            with self.subTest(name=name):
                prepared = self.prepare()
                path = self.root / "controls" / prepared["reference_id"] / name
                content = bytearray(path.read_bytes())
                content[-5] ^= 1
                path.write_bytes(content)
                with self.assertRaisesRegex(ValueError, "已变化"):
                    self.load(prepared)
        prepared = self.prepare()
        path = self.root / "controls" / prepared["reference_id"] / "metadata.json"
        metadata = json.loads(path.read_text(encoding="utf-8"))
        metadata["settings"]["margin"] = 0.2
        path.write_text(json.dumps(metadata), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "元数据校验失败"):
            self.load(prepared)

    def test_bad_reference_or_config_is_rejected(self):
        prepared = self.prepare()
        for settings in ({"reference_id": "../secret"}, {"reference_sha256": "a" * 64}, {"method": "unknown"},
                         {"strength": 0}, {"strength": True}, {"strength": float("nan")},
                         {"control_scale": 3}, {"embroidery_detail": "true"}):
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                self.load(prepared, **settings)
        missing = {**prepared, "reference_id": "CTRL-" + "a" * 32}
        with self.assertRaisesRegex(ValueError, "尚未准备完成"):
            self.load(missing)
        result = self.load(prepared, method="img2img", control_scale=0)
        self.assertEqual(result["method"], "img2img")
        self.assertFalse(result["embroidery_detail"])

    def test_concurrent_preparations_are_independent_and_deterministic(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: self.prepare(), range(4)))
        self.assertEqual(len({item["reference_id"] for item in results}), 4)
        self.assertEqual(len({item["reference_sha256"] for item in results}), 1)
        for result in results:
            self.load(result)
        self.assertFalse(any(path.name.startswith(".") for path in (self.root / "controls").iterdir()))

    def test_failed_artifact_write_never_publishes_a_usable_id(self):
        with patch.object(Path, "write_bytes", side_effect=OSError("fixture disk error")), self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(list((self.root / "controls").glob("CTRL-*")), [])
        self.assertEqual(list((self.root / "controls").iterdir()), [])

    def test_failed_metadata_write_and_publish_remove_owned_staging_directories(self):
        for operation in ("write_text", "rename"):
            with self.subTest(operation=operation), patch.object(Path, operation, side_effect=OSError("fixture publish failure")), self.assertRaises(OSError):
                self.prepare()
            self.assertEqual(list((self.root / "controls").iterdir()), [])

    def test_micro_transparent_outer_ring_does_not_control_layout_or_edges(self):
        image = Image.new("RGBA", (120, 120), (255, 255, 255, 0))
        draw = ImageDraw.Draw(image)
        draw.ellipse((2, 2, 117, 117), outline=(0, 0, 0, 1), width=2)
        draw.rectangle((35, 45, 84, 74), fill=(10, 20, 50, 255))
        for layout in ("centered", "preserve"):
            with self.subTest(layout=layout):
                loaded = self.load(self.prepare(image, layout=layout))
                control = np.array(loaded["control_image"])[:, :, 0]
                visible = references._alpha_support(np.array(loaded["mask_image"]))
                bounds = Image.fromarray(visible).getbbox()
                self.assertEqual(int(control[:bounds[1] - 3].sum()), 0)
                self.assertEqual(int(control[bounds[3] + 3:].sum()), 0)
                self.assertGreater(int(control.sum()), 0)
                if layout == "centered":
                    self.assertGreater(bounds[2] - bounds[0], 380)
                    self.assertAlmostEqual((bounds[2] - bounds[0]) / (bounds[3] - bounds[1]), 50 / 30, delta=0.03)

    def test_fully_micro_transparent_noise_cannot_be_prepared_as_a_subject(self):
        with self.assertRaisesRegex(ValueError, "透明度过低"):
            self.prepare(Image.new("RGBA", (32, 32), (0, 0, 0, 1)), mask_mode="alpha")

    def test_dx027_dark_mask_does_not_create_an_invisible_circular_frame(self):
        path = references.CANONICAL_ROOT / "01_编号图像" / "DX027.png"
        if not path.exists():
            self.skipTest("Canonical DX027 is unavailable in this environment")
        prepared = references.prepare_reference({"pattern_id": "DX027", "mask_mode": "dark", "threshold": 190,
            "palette_mode": "solid", "foreground_color": "#D62240", "background_color": "#285795"})
        loaded = self.load(prepared)
        control = np.array(loaded["control_image"])[:, :, 0]
        support = references._alpha_support(np.array(loaded["mask_image"]))
        bounds = Image.fromarray(support).getbbox()
        self.assertEqual(int(control[:bounds[1] - 3].sum()), 0)
        self.assertEqual(int(control[bounds[3] + 3:].sum()), 0)
        self.assertGreater(np.count_nonzero(control), 1000)
        self.assertEqual(loaded["metadata"]["preprocessor"], "masked-reference-canny-3")

    def test_old_references_remain_readable_without_reprocessing_or_new_fields(self):
        for version in ("masked-reference-canny-1", "masked-reference-canny-2"):
            with self.subTest(version=version):
                prepared = self.prepare()
                directory = self.root / "controls" / prepared["reference_id"]
                path = directory / "metadata.json"
                metadata = json.loads(path.read_text(encoding="utf-8"))
                metadata["preprocessor"] = version
                metadata["settings"].pop("texture_mode")
                metadata["reference_sha256"] = references._fingerprint(metadata)
                path.write_text(json.dumps(metadata), encoding="utf-8")
                old_bytes = {name: (directory / name).read_bytes() for name in references.ARTIFACT_NAMES.values()}
                loaded = self.load({**prepared, "reference_sha256": metadata["reference_sha256"]})
                self.assertEqual(loaded["metadata"], metadata)
                for name, original in old_bytes.items():
                    self.assertEqual((directory / name).read_bytes(), original)

    def test_default_texture_retains_version_two_pixels(self):
        # Captured directly from the v2 renderer before adding materialization.
        expected = {
            "source": "f939948fe9cf1e4b35d94d36d48cd15730d09a6f389a442bb0e7fafb122b3ca1",
            "mask": "785fd2a84b623e31d9576840aed1ca5456bf5c805a3ab54f8a43f189b5b5bc4d",
            "init": "e1423157ed3ed92e91ea633205fc46d417a442f5b5965d280fcd3151e9ec1116",
            "control": "40ffa6dba77c79be303e1b732a2dac4674552da6585f7b4400dee781670f4161",
        }
        for settings in ({}, {"texture_mode": "source"}):
            with self.subTest(settings=settings):
                images, _ = references._render(silhouette(), references._settings(settings))
                self.assertEqual({kind: hashlib.sha256(image.tobytes()).hexdigest() for kind, image in images.items()}, expected)
        prepared = self.prepare()
        self.assertEqual(prepared["settings"]["texture_mode"], "source")
        self.assertNotIn("material", prepared)
        self.assertNotIn("material", self.load(prepared)["metadata"])

    def test_stitched_changes_only_init_and_is_deterministic(self):
        plain = self.load(self.prepare())
        prepared = self.prepare(texture_mode="stitched")
        stitched = self.load(prepared)
        repeated = self.prepare(texture_mode="stitched")
        material = {"version": MATERIAL_VERSION, "noise_seed": NOISE_SEED}
        self.assertEqual(prepared["material"], material)
        self.assertEqual(stitched["metadata"]["material"], material)
        self.assertEqual(prepared["reference_sha256"], repeated["reference_sha256"])
        self.assertEqual(prepared["init_image"], repeated["init_image"])
        self.assertNotEqual(plain["metadata"]["reference_sha256"], prepared["reference_sha256"])
        for kind in ("source", "mask", "control"):
            self.assertEqual(plain["metadata"]["files"][kind], stitched["metadata"]["files"][kind])
        self.assertNotEqual(plain["image"].tobytes(), stitched["image"].tobytes())
        self.assertEqual(plain["image"].size, stitched["image"].size)
        self.assertTrue(any("针线" in warning for warning in prepared["warnings"]))

    def test_material_retains_background_mean_and_dark_thread_highlights(self):
        for background in ("#000000", "#FFFFFF", "#F5F0E6", "#25549A"):
            with self.subTest(background=background):
                plain = self.load(self.prepare(palette_mode="solid", foreground_color="#17191D", background_color=background))
                image, mask = plain["image"], plain["mask_image"]
                output = materialize(image, mask)
                source_pixels, pixels = np.array(image), np.array(output)
                outside = np.array(mask) == 0
                inside = np.array(mask) == 255
                self.assertEqual(output.mode, "RGB")
                self.assertEqual(output.size, image.size)
                self.assertEqual(output.tobytes(), materialize(image, mask).tobytes())
                np.testing.assert_array_equal(source_pixels[outside].sum(axis=0), pixels[outside].sum(axis=0))
                self.assertGreater(float(pixels[inside, 0].std()), 1)
                self.assertGreater(int(pixels[inside, 0].max()), int(source_pixels[inside, 0].max()))
                np.testing.assert_allclose(pixels[inside].mean(axis=0), source_pixels[inside].mean(axis=0), atol=1)

    def test_material_metadata_and_texture_settings_are_bound_to_reference_hash(self):
        for field in ("material", "settings"):
            with self.subTest(field=field):
                prepared = self.prepare(texture_mode="stitched")
                path = self.root / "controls" / prepared["reference_id"] / "metadata.json"
                metadata = json.loads(path.read_text(encoding="utf-8"))
                if field == "material":
                    metadata["material"]["noise_seed"] += 1
                else:
                    metadata["settings"]["texture_mode"] = "source"
                path.write_text(json.dumps(metadata), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "元数据校验失败"):
                    self.load(prepared)

    def test_stitched_metadata_requires_the_recorded_material_implementation(self):
        for material in (None, {"version": "unknown", "noise_seed": NOISE_SEED},
                         {"version": MATERIAL_VERSION, "noise_seed": 0}):
            with self.subTest(material=material):
                prepared = self.prepare(texture_mode="stitched")
                path = self.root / "controls" / prepared["reference_id"] / "metadata.json"
                metadata = json.loads(path.read_text(encoding="utf-8"))
                metadata["material"] = material
                metadata["reference_sha256"] = references._fingerprint(metadata)
                path.write_text(json.dumps(metadata), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "材质版本"):
                    self.load({**prepared, "reference_sha256": metadata["reference_sha256"]})

    def test_material_rejects_mismatched_mask_dimensions(self):
        with self.assertRaisesRegex(ValueError, "identical dimensions"):
            materialize(Image.new("RGB", (512, 512)), Image.new("L", (384, 512)))


if __name__ == "__main__":
    unittest.main()

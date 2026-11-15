"""CPU-only, immutable reference preparation for local image conditioning."""

from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import re
import shutil
from typing import Any
import uuid

from PIL import Image, ImageOps, UnidentifiedImageError

from embroidery_material import MATERIAL_VERSION, NOISE_SEED, materialize
from local_vision import MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS

PROJECT_ROOT = Path(__file__).resolve().parent
CANONICAL_ROOT = PROJECT_ROOT / "纹样库" / "侗族" / "_标注成果"
CONTROL_ROOT = PROJECT_ROOT / "outputs" / "controls"
PREPROCESSOR_VERSION = "masked-reference-canny-3"
SUPPORTED_PREPROCESSORS = ("masked-reference-canny-1", "masked-reference-canny-2", PREPROCESSOR_VERSION)
ARTIFACT_NAMES = {"source": "source.png", "mask": "mask.png", "init": "init.png", "control": "control.png"}
REFERENCE_ID = re.compile(r"CTRL-[a-f0-9]{32}")
SHA256 = re.compile(r"[a-f0-9]{64}")


def _number(value: Any, name: str, minimum: float, maximum: float, *, integer: bool = False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}需要为有效数值。")
    if not minimum <= value <= maximum or (integer and value != int(value)):
        raise ValueError(f"{name}需要在{minimum}至{maximum}之间" + ("且为整数。" if integer else "。"))
    return int(value) if integer else float(value)


def _choice(value: Any, name: str, choices: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f"{name}需要为{'、'.join(choices)}之一。")
    return value


def _color(value: Any, name: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError(f"{name}需要为#RRGGBB颜色。")
    return value.upper()


def _settings(payload: dict[str, Any]) -> dict[str, Any]:
    crop = payload.get("crop", [0, 0, 1, 1])
    if not isinstance(crop, (list, tuple)) or len(crop) != 4:
        raise ValueError("crop需要为归一化的[x0,y0,x1,y1]四个坐标。")
    crop = [_number(value, "裁切坐标", 0, 1) for value in crop]
    if crop[0] >= crop[2] or crop[1] >= crop[3]:
        raise ValueError("裁切区域的右下坐标需要大于左上坐标。")
    width = _number(payload.get("width", 512), "width", 384, 768, integer=True)
    height = _number(payload.get("height", 512), "height", 384, 768, integer=True)
    if width % 8 or height % 8:
        raise ValueError("参考画布宽高需要为8的倍数。")
    mask_mode = _choice(payload.get("mask_mode", "dark"), "mask_mode", ("dark", "light", "saturated", "alpha"))
    return {
        "crop": crop,
        "mask_mode": mask_mode,
        "threshold": _number(payload.get("threshold", 80 if mask_mode == "saturated" else 180), "threshold", 0, 255, integer=True),
        "palette_mode": _choice(payload.get("palette_mode", "source"), "palette_mode", ("source", "solid")),
        "texture_mode": _choice(payload.get("texture_mode", "source"), "texture_mode", ("source", "stitched")),
        "foreground_color": _color(payload.get("foreground_color", "#C63D3D"), "foreground_color"),
        "background_color": _color(payload.get("background_color", "#F5F0E6"), "background_color"),
        "layout": _choice(payload.get("layout", "centered"), "layout", ("centered", "horizontal-band", "preserve")),
        "margin": _number(payload.get("margin", 0.12), "margin", 0.05, 0.3),
        "width": width,
        "height": height,
    }


def _decode_image(raw: bytes) -> Image.Image:
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("参考图需为不超过8MB的PNG、JPEG或WebP图片。")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("参考图格式需要为PNG、JPEG或WebP。")
            if image.width * image.height > MAX_IMAGE_PIXELS or min(image.size) < 16:
                raise ValueError("参考图边长需至少16像素，总像素不超过1600万。")
            image.load()
            # Preserve alpha for segmentation. Compositing happens after masking.
            normalized = ImageOps.exif_transpose(image).convert("RGBA")
            normalized.info.clear()
            return normalized
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError("参考图无法解码，请重新选择图片。") from error


def _source(payload: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
    source_keys = [key for key in ("pattern_id", "element_id", "image_data_url") if key in payload]
    if len(source_keys) != 1:
        raise ValueError("请在pattern_id、element_id和image_data_url中指定一个参考来源。")
    key = source_keys[0]
    if key == "image_data_url":
        value = payload[key]
        if not isinstance(value, str) or len(value) > MAX_IMAGE_BYTES * 4 // 3 + 100:
            raise ValueError("上传参考图需为不超过8MB的图片数据。")
        match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)", value)
        if not match:
            raise ValueError("上传参考图需要PNG、JPEG或WebP的base64数据。")
        try:
            raw = base64.b64decode(match.group(2).replace("\r", "").replace("\n", ""), validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError("参考图编码无效。") from error
        name = payload.get("image_name", "上传参考图")
        if not isinstance(name, str) or len(name) > 256:
            raise ValueError("image_name需要为不超过256字符的名称。")
        summary = {"kind": "upload", "name": name}
    else:
        identifier = payload[key]
        identifier_pattern = r"DX\d{3}" if key == "pattern_id" else r"DXE\d{3}"
        if not isinstance(identifier, str) or not re.fullmatch(identifier_pattern, identifier):
            raise ValueError("参考资料编号无效。")
        catalogue_name = "patterns.json" if key == "pattern_id" else "elements.json"
        try:
            catalogue = json.loads((CANONICAL_ROOT / "03_标注数据" / catalogue_name).read_text(encoding="utf-8-sig"))
            if not isinstance(catalogue, list) or not all(isinstance(row, dict) for row in catalogue):
                raise ValueError("规范参考资料映射无效。")
            record = next((row for row in catalogue if row.get("id") == identifier), None)
            if record is None:
                raise ValueError("参考资料编号不在规范侗族资料库中。")
            path = (CANONICAL_ROOT / record["image"]).resolve()
            if not path.is_relative_to(CANONICAL_ROOT.resolve()):
                raise ValueError("规范参考图片路径超出资料目录。")
            if path.stat().st_size > MAX_IMAGE_BYTES:
                raise ValueError("规范参考图片超过8MB限制。")
            raw = path.read_bytes()
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("规范参考图片尚未准备完成或资料映射无效。") from error
        summary = {"kind": "pattern" if key == "pattern_id" else "element", "id": identifier, "name": record["name"]}
        if key == "element_id":
            summary["pattern_id"] = record["pattern_id"]
    image = _decode_image(raw)
    summary.update({"width": image.width, "height": image.height, "sha256": hashlib.sha256(raw).hexdigest()})
    return image, summary


def _alpha_support(mask):
    import numpy as np

    # Opacity-1 interpolation remnants must not become opaque control contours.
    # Relative support also retains uniformly semi-transparent source subjects.
    threshold = max(16, min(128, (int(mask.max()) + 1) // 2))
    return (mask >= threshold).astype(np.uint8) * 255


def _render(image: Image.Image, settings: dict[str, Any]) -> tuple[dict[str, Image.Image], list[str]]:
    import cv2
    import numpy as np

    x0, y0, x1, y1 = settings["crop"]
    crop_box = (round(x0 * image.width), round(y0 * image.height), round(x1 * image.width), round(y1 * image.height))
    if crop_box[2] - crop_box[0] < 2 or crop_box[3] - crop_box[1] < 2:
        raise ValueError("裁切区域过小，请至少保留2×2像素。")
    cropped = image.crop(crop_box)
    rgba = np.array(cropped)
    rgb, alpha = rgba[:, :, :3], rgba[:, :, 3]
    luminance = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    mode = settings["mask_mode"]
    if mode == "alpha":
        mask = alpha.copy()
    else:
        values = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)[:, :, 1] if mode == "saturated" else luminance
        selected = values <= settings["threshold"] if mode == "dark" else values >= settings["threshold"]
        mask = np.where(selected, alpha, 0).astype(np.uint8)
    bounds = Image.fromarray(_alpha_support(mask)).getbbox()
    if bounds is None:
        raise ValueError("当前裁切和阈值未选中可见主体，或主体透明度过低，请调整蒙版模式、阈值或裁切区域。")

    warnings = []
    if mode == "alpha" and int(alpha.min()) == 255:
        warnings.append("参考图没有透明区域，alpha模式会保留完整矩形；请核对控制图中的背景与外框。")
    elif float(np.count_nonzero(mask)) / mask.size > 0.98:
        warnings.append("蒙版覆盖了几乎整个裁切区域，请核对是否选中了背景或实物外框。")

    if settings["palette_mode"] == "solid":
        color = np.array([int(settings["foreground_color"][index:index + 2], 16) for index in (1, 3, 5)], dtype=np.float32)
        light = luminance.astype(np.float32)
        detail = light - cv2.GaussianBlur(light, (0, 0), 1.2)
        rgb = np.clip(color + detail[:, :, None] * 0.75, 0, 255).astype(np.uint8)
    foreground = Image.fromarray(np.dstack((rgb, mask)), "RGBA")
    if settings["layout"] != "preserve":
        foreground = foreground.crop(bounds)
    width, height, margin = settings["width"], settings["height"], settings["margin"]
    available_width = width * (1 - 2 * margin)
    available_height = height * (1 - 2 * margin)
    if settings["layout"] == "horizontal-band":
        available_height = min(available_height, height * 0.45)
    scale = min(available_width / foreground.width, available_height / foreground.height)
    size = (max(1, int(foreground.width * scale)), max(1, int(foreground.height * scale)))
    foreground = foreground.resize(size, Image.Resampling.LANCZOS)
    destination = ((width - size[0]) // 2, (height - size[1]) // 2)
    canvas = Image.new("RGBA", (width, height), settings["background_color"])
    canvas.alpha_composite(foreground, dest=destination)
    init_image = canvas.convert("RGB")
    final_mask = Image.new("L", (width, height), 0)
    final_mask.paste(foreground.getchannel("A"), destination)

    support = _alpha_support(np.array(final_mask))
    contour = cv2.Canny(support, 80, 160)
    interior = cv2.erode(support, np.ones((3, 3), dtype=np.uint8), iterations=1)
    internal_edges = cv2.Canny(cv2.cvtColor(np.array(init_image), cv2.COLOR_RGB2GRAY), 80, 160)
    edges = cv2.bitwise_or(contour, cv2.bitwise_and(internal_edges, interior))
    control_image = Image.fromarray(np.repeat(edges[:, :, None], 3, axis=2), "RGB")
    # Preserve structural control edges independently of the optional input yarn.
    if settings.get("texture_mode", "source") == "stitched":
        init_image = materialize(init_image, final_mask)
        warnings.append("已为扩散输入添加确定性针线与织物材质，细针方向为统一近似；最终针脚真实性和复杂局部走向需查看生成结果确认。")
    return {"source": image, "mask": final_mask, "init": init_image, "control": control_image}, warnings


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def _fingerprint(metadata: dict[str, Any]) -> str:
    content = {key: metadata[key] for key in ("version", "preprocessor", "source", "settings", "files", "warnings")}
    if "material" in metadata:
        content["material"] = metadata["material"]
    encoded = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def prepare_reference(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("参考图准备请求需要为JSON对象。")
    settings = _settings(payload)
    source_image, source = _source(payload)
    images, warnings = _render(source_image, settings)
    artifacts = {kind: _png_bytes(image) for kind, image in images.items()}
    reference_id = "CTRL-" + uuid.uuid4().hex
    metadata = {
        "version": 1, "preprocessor": PREPROCESSOR_VERSION, "reference_id": reference_id,
        "created_at": datetime.now(timezone.utc).isoformat(), "source": source, "settings": settings,
        "files": {kind: {"name": ARTIFACT_NAMES[kind], "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
                  for kind, raw in artifacts.items()},
        "warnings": warnings,
    }
    if settings["texture_mode"] == "stitched":
        metadata["material"] = {"version": MATERIAL_VERSION, "noise_seed": NOISE_SEED}
    metadata["reference_sha256"] = _fingerprint(metadata)
    CONTROL_ROOT.mkdir(parents=True, exist_ok=True)
    temporary = CONTROL_ROOT / ("." + reference_id + ".preparing")
    temporary.mkdir(exist_ok=False)
    # The final ID becomes available only after every artifact and manifest exists.
    # Concurrent preparations have independent directories and no mutable entries.
    try:
        for kind, raw in artifacts.items():
            (temporary / ARTIFACT_NAMES[kind]).write_bytes(raw)
        (temporary / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.rename(CONTROL_ROOT / reference_id)
    finally:
        if temporary.exists():
            resolved = temporary.resolve()
            if resolved.parent != CONTROL_ROOT.resolve() or resolved.name != "." + reference_id + ".preparing":
                raise ValueError("临时参考目录位置异常，无法清理。")
            shutil.rmtree(resolved)
    result = {"reference_id": reference_id, "reference_sha256": metadata["reference_sha256"],
            "source": source, "settings": settings, "init_image": _data_url(artifacts["init"]),
            "control_image": _data_url(artifacts["control"]), "mask_image": _data_url(artifacts["mask"]),
            "warnings": warnings}
    if "material" in metadata:
        result["material"] = metadata["material"]
    return result


def load_reference_conditioning(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ValueError("reference_conditioning需要为JSON对象。")
    method = _choice(config.get("method"), "method", ("canny-img2img", "img2img"))
    strength = _number(config.get("strength", 0.55), "strength", 0.25, 0.85)
    control_scale = _number(config.get("control_scale", 0.8), "control_scale", 0, 2)
    embroidery_detail = config.get("embroidery_detail", False)
    if not isinstance(embroidery_detail, bool):
        raise ValueError("embroidery_detail需要为布尔值。")
    reference_id, digest = config.get("reference_id"), config.get("reference_sha256")
    if not isinstance(reference_id, str) or not REFERENCE_ID.fullmatch(reference_id):
        raise ValueError("结构参考编号无效，请重新准备参考图。")
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise ValueError("结构参考校验值无效，请重新准备参考图。")
    directory = (CONTROL_ROOT / reference_id).resolve()
    if directory.parent != CONTROL_ROOT.resolve():
        raise ValueError("结构参考目录无效。")
    try:
        manifest_path = directory / "metadata.json"
        if manifest_path.resolve().parent != directory:
            raise ValueError("结构参考元数据路径校验失败。")
        if manifest_path.stat().st_size > 256 * 1024:
            raise ValueError("结构参考元数据过大。")
        metadata = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (not isinstance(metadata, dict) or metadata.get("version") != 1 or metadata.get("preprocessor") not in SUPPORTED_PREPROCESSORS
                or metadata.get("reference_id") != reference_id or metadata.get("reference_sha256") != digest
                or _fingerprint(metadata) != digest):
            raise ValueError("结构参考元数据校验失败，请重新准备参考图。")
        if not isinstance(metadata["settings"], dict) or not isinstance(metadata["files"], dict):
            raise ValueError("结构参考元数据格式无效。")
        settings = _settings(metadata["settings"])
        expected_material = {"version": MATERIAL_VERSION, "noise_seed": NOISE_SEED} if settings["texture_mode"] == "stitched" else None
        if metadata.get("material") != expected_material:
            raise ValueError("结构参考材质版本或参数校验失败，请重新准备参考图。")
        if set(metadata["files"]) != set(ARTIFACT_NAMES):
            raise ValueError("结构参考文件记录不完整。")
        images = {}
        for kind, filename in ARTIFACT_NAMES.items():
            entry = metadata["files"][kind]
            path = directory / filename
            if not isinstance(entry, dict) or path.resolve().parent != directory or entry.get("name") != filename:
                raise ValueError("结构参考文件路径校验失败。")
            size = path.stat().st_size
            if size != entry.get("bytes") or size > MAX_IMAGE_PIXELS * 4 + 1024 * 1024:
                raise ValueError("结构参考文件大小校验失败。")
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != entry.get("sha256"):
                raise ValueError("结构参考文件已变化，请重新准备参考图。")
            if kind == "source":
                continue
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "PNG" or image.size != (settings["width"], settings["height"]):
                    raise ValueError("结构参考图像尺寸或格式校验失败。")
                image.load()
                images[kind] = image.convert("L" if kind == "mask" else "RGB")
    except (OSError, KeyError, TypeError, json.JSONDecodeError, UnidentifiedImageError) as error:
        raise ValueError("结构参考尚未准备完成或文件已损坏，请重新准备参考图。") from error
    return {"metadata": metadata, "image": images["init"], "control_image": images["control"],
            "mask_image": images["mask"], "method": method, "strength": strength,
            "control_scale": control_scale, "embroidery_detail": embroidery_detail}

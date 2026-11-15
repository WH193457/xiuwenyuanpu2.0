from __future__ import annotations

import base64
import gc
import io
import json
import logging
import math
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageOps
from scipy import ndimage

sys.dont_write_bytecode = True

PROJECT_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = Path(
    os.environ.get(
        "XIUVEN_DATA_ROOT",
        str(PROJECT_ROOT / "纹样库" / "侗族" / "_标注成果"),
    )
).resolve()
SAM3_ROOT = Path(os.environ.get("SAM3_ROOT", str(PROJECT_ROOT / "external" / "sam3"))).resolve()
CHECKPOINT = Path(os.environ.get("SAM3_CHECKPOINT", str(SAM3_ROOT / "sam3.pt")))
PATTERNS_PATH = SOURCE_ROOT / "03_标注数据" / "patterns.json"
IMAGE_ROOT = SOURCE_ROOT / "01_编号图像"
HOST = os.environ.get("SAM3_SERVICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SAM3_SERVICE_PORT", "8000"))
MAX_BODY_BYTES = 64 * 1024

OUTPUT_ROOT = PROJECT_ROOT / "outputs"
OUTPUT_ROOT.mkdir(exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(OUTPUT_ROOT / "sam3-service.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
LOGGER = logging.getLogger("sam3-service")

MODEL_LOCK = threading.Lock()
INFERENCE_LOCK = threading.Lock()
MODEL_STATE = "cold"
MODEL_ERROR: str | None = None
MODEL_LOAD_SECONDS: float | None = None
PROCESSOR: Any = None
TORCH: Any = None
PATTERNS: dict[str, dict[str, Any]] = {}


def require_runtime() -> None:
    for path, label in (
        (PATTERNS_PATH, "纹样索引"),
        (SAM3_ROOT / "sam3", "SAM3 源码"),
        (CHECKPOINT, "SAM3 权重"),
    ):
        if not path.exists():
            raise FileNotFoundError(f"未找到{label}：{path}")


def load_pattern_index() -> None:
    global PATTERNS
    data = json.loads(PATTERNS_PATH.read_text(encoding="utf-8"))
    PATTERNS = {item["id"].upper(): item for item in data}


def load_model() -> tuple[Any, Any]:
    global MODEL_STATE, MODEL_ERROR, MODEL_LOAD_SECONDS, PROCESSOR, TORCH
    if PROCESSOR is not None:
        return PROCESSOR, TORCH
    with MODEL_LOCK:
        if PROCESSOR is not None:
            return PROCESSOR, TORCH
        MODEL_STATE = "loading"
        MODEL_ERROR = None
        started = time.perf_counter()
        try:
            sys.path.insert(0, str(SAM3_ROOT))
            import torch
            from sam3.model.sam3_image_processor import Sam3Processor
            from sam3.model_builder import build_sam3_image_model

            if not torch.cuda.is_available():
                raise RuntimeError("SAM3 需要 CUDA，但当前 Python 环境未检测到可用 GPU。")
            model = build_sam3_image_model(
                checkpoint_path=str(CHECKPOINT),
                device="cuda",
                eval_mode=True,
                load_from_HF=False,
                compile=False,
            )
            PROCESSOR = Sam3Processor(model, confidence_threshold=0.25)
            TORCH = torch
            MODEL_LOAD_SECONDS = time.perf_counter() - started
            MODEL_STATE = "ready"
            LOGGER.info("SAM3 ready in %.2fs on %s", MODEL_LOAD_SECONDS, torch.cuda.get_device_name(0))
            return PROCESSOR, TORCH
        except Exception as error:
            MODEL_STATE = "error"
            MODEL_ERROR = str(error)
            LOGGER.exception("SAM3 model load failed")
            raise


def clamp_normalized_box(values: Any) -> list[float]:
    if not isinstance(values, list) or len(values) != 4:
        raise ValueError("box 必须是 [x0, y0, x1, y1]。")
    try:
        x0, y0, x1, y1 = (float(value) for value in values)
    except (TypeError, ValueError) as error:
        raise ValueError("box 坐标必须是数字。") from error
    if not all(math.isfinite(value) for value in (x0, y0, x1, y1)):
        raise ValueError("box 坐标必须是有限数字。")
    x0, y0 = min(max(x0, 0.0), 0.98), min(max(y0, 0.0), 0.98)
    x1, y1 = min(max(x1, x0 + 0.02), 1.0), min(max(y1, y0 + 0.02), 1.0)
    if (x1 - x0) * (y1 - y0) < 0.0025:
        raise ValueError("框选区域过小，请至少覆盖图像面积的 0.25%。")
    return [x0, y0, x1, y1]


def pixel_box(box: list[float], width: int, height: int) -> list[float]:
    return [box[0] * width, box[1] * height, box[2] * width, box[3] * height]


def normalized_cxcywh(box: list[float]) -> list[float]:
    return [
        (box[0] + box[2]) / 2,
        (box[1] + box[3]) / 2,
        box[2] - box[0],
        box[3] - box[1],
    ]


def box_iou(a: list[float], b: list[float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    return intersection / max(area_a + area_b - intersection, 1e-9)


def mask_box(mask: np.ndarray) -> list[float]:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return [0.0, 0.0, 1.0, 1.0]
    return [float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)]


def stabilize_single_mask(mask: np.ndarray) -> np.ndarray:
    """Drop tiny detached neighbours only when one component clearly dominates."""
    labels, count = ndimage.label(mask)
    if count <= 1:
        return mask
    sizes = np.bincount(labels.ravel())
    component_sizes = sizes[1:]
    largest = int(component_sizes.max(initial=0))
    total = int(component_sizes.sum())
    if largest <= 0 or largest / max(total, 1) < 0.82:
        return mask
    keep = sizes >= max(8, round(largest * 0.012))
    keep[0] = False
    return keep[labels]


def prompt_gate(shape: tuple[int, int], prompt: list[float]) -> np.ndarray:
    height, width = shape
    x0, y0, x1, y1 = (int(round(value)) for value in prompt)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    gate = np.zeros(shape, dtype=bool)
    gate[y0:y1, x0:x1] = True
    return gate


def foreground_prior(image: Image.Image, prompt: list[float]) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    """Estimate patterned foreground from dominant colours along the prompt border.

    The prior is deliberately weak on visually busy borders and strong on plain cloth/paper.
    It complements SAM3 rather than replacing it.
    """
    width, height = image.size
    x0, y0, x1, y1 = (int(round(value)) for value in prompt)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    crop = np.asarray(image.convert("LAB"), dtype=np.float32)[y0:y1, x0:x1]
    crop_h, crop_w = crop.shape[:2]
    gate = prompt_gate((height, width), prompt)
    if crop_h < 8 or crop_w < 8:
        return np.zeros((height, width), dtype=bool), gate, {"prior_reliability": 0.0, "border_background": 0.0, "foreground_fraction": 0.0}

    step = max(1, int(math.sqrt((crop_h * crop_w) / 18_000)))
    samples = crop[::step, ::step].reshape(-1, 3)
    # Deterministic farthest-point initialisation avoids random output between requests.
    quantized = (samples // 8).astype(np.int16)
    unique, counts = np.unique(quantized, axis=0, return_counts=True)
    bucket = unique[int(np.argmax(counts))]
    first = samples[np.all(quantized == bucket, axis=1)].mean(axis=0)
    centers = [first]
    for _ in range(3):
        distances = np.min(np.stack([np.sum((samples - center) ** 2, axis=1) for center in centers]), axis=0)
        centers.append(samples[int(np.argmax(distances))])
    centers_array = np.stack(centers).astype(np.float32)
    for _ in range(10):
        distances = np.sum((samples[:, None, :] - centers_array[None, :, :]) ** 2, axis=2)
        labels = distances.argmin(axis=1)
        next_centers = centers_array.copy()
        for index in range(len(centers_array)):
            members = samples[labels == index]
            if len(members):
                next_centers[index] = members.mean(axis=0)
        if np.max(np.abs(next_centers - centers_array)) < 0.25:
            break
        centers_array = next_centers

    full_distances = np.sum((crop[:, :, None, :] - centers_array[None, None, :, :]) ** 2, axis=3)
    full_labels = full_distances.argmin(axis=2)
    ring_width = max(3, round(min(crop_h, crop_w) * 0.065))
    ring = np.zeros((crop_h, crop_w), dtype=bool)
    ring[:ring_width, :] = True
    ring[-ring_width:, :] = True
    ring[:, :ring_width] = True
    ring[:, -ring_width:] = True
    border_counts = np.array([(full_labels[ring] == index).sum() for index in range(4)], dtype=np.float64)
    border_shares = border_counts / max(float(ring.sum()), 1.0)
    primary = int(border_shares.argmax())
    corner_width = max(4, ring_width)
    corner_dominants = [
        int(np.bincount(values.ravel(), minlength=4).argmax())
        for values in (
            full_labels[:corner_width, :corner_width],
            full_labels[:corner_width, -corner_width:],
            full_labels[-corner_width:, :corner_width],
            full_labels[-corner_width:, -corner_width:],
        )
    ]
    repeated_corner_clusters = {
        index for index in range(4) if corner_dominants.count(index) >= 3
    }
    center_distances = np.sqrt(np.sum((centers_array - centers_array[primary]) ** 2, axis=1))
    background_clusters = {
        index for index in range(4)
        if index == primary
        or index in repeated_corner_clusters
        or (center_distances[index] < 22 and border_shares[index] > 0.025)
        or (border_shares[index] > max(0.16, border_shares[primary] * 0.42) and center_distances[index] < 38)
    }
    background_centers = centers_array[sorted(background_clusters)]
    distance_to_background = np.sqrt(np.min(np.sum((crop[:, :, None, :] - background_centers[None, None, :, :]) ** 2, axis=3), axis=2))
    border_bg_distances = distance_to_background[ring]
    threshold = float(np.clip(np.percentile(border_bg_distances, 97) + 7.0, 11.0, 38.0))
    foreground_crop = distance_to_background > threshold

    # Remove dust while preserving small eyes, petals and separated stitch details.
    labels, component_count = ndimage.label(foreground_crop)
    if component_count:
        sizes = np.bincount(labels.ravel())
        minimum = max(12, round(crop_h * crop_w * 0.00006))
        keep = sizes >= minimum
        keep[0] = False
        foreground_crop = keep[labels]
    foreground = np.zeros((height, width), dtype=bool)
    foreground[y0:y1, x0:x1] = foreground_crop
    border_background = float((~foreground_crop & ring).sum()) / max(int(ring.sum()), 1)
    reliability = float(np.clip((border_background - 0.52) / 0.38, 0.0, 1.0))
    return foreground, gate, {
        "prior_reliability": round(reliability, 6),
        "border_background": round(border_background, 6),
        "foreground_fraction": round(float(foreground_crop.mean()), 6),
    }


def candidate_metrics(mask: np.ndarray, predicted: list[float], score: float, prompt: list[float], foreground: np.ndarray, gate: np.ndarray, prior: dict[str, float], source: str) -> dict[str, Any]:
    height, width = mask.shape
    x0, y0, x1, y1 = (int(round(value)) for value in prompt)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    mask_area = int(mask.sum())
    prompt_area = max(1, (x1 - x0) * (y1 - y0))
    inside = int(mask[y0:y1, x0:x1].sum())
    inside_fraction = inside / max(mask_area, 1)
    coverage = inside / prompt_area
    area_ratio = mask_area / prompt_area
    overlap = box_iou(predicted, prompt)
    pcx, pcy = (prompt[0] + prompt[2]) / 2, (prompt[1] + prompt[3]) / 2
    bcx, bcy = (predicted[0] + predicted[2]) / 2, (predicted[1] + predicted[3]) / 2
    diagonal = math.hypot(prompt[2] - prompt[0], prompt[3] - prompt[1])
    center_fit = max(0.0, 1.0 - math.hypot(bcx - pcx, bcy - pcy) / max(diagonal, 1.0))
    edge_touches = sum(int(edge.any()) for edge in (mask[0], mask[-1], mask[:, 0], mask[:, -1]))
    foreground_agreement = float((mask & foreground).sum()) / max(mask_area, 1)
    foreground_pixels = int((foreground & gate).sum())
    foreground_coverage = float((mask & foreground & gate).sum()) / max(foreground_pixels, 1)
    background_leakage = float((mask & gate & ~foreground).sum()) / max(int((mask & gate).sum()), 1)
    reliability = float(prior["prior_reliability"])
    model_weight = 0.34 - 0.14 * reliability
    prior_weight = 0.36 * reliability
    # Completeness is trustworthy only when the crop border is very clearly cloth/paper.
    # This keeps a moderate prior from swallowing details in busy, connected motifs.
    coverage_weight = 0.10 * float(np.clip((reliability - 0.55) / 0.45, 0.0, 1.0))
    fit = (
        model_weight * score
        + 0.20 * overlap
        + 0.10 * inside_fraction
        + 0.10 * center_fit
        + prior_weight * foreground_agreement
        + coverage_weight * foreground_coverage
        - prior_weight * background_leakage
    )
    if source == "hybrid":
        fit += 0.025 * reliability
    elif source == "foreground":
        fit += 0.015 * reliability
    if area_ratio < 0.02:
        fit -= 0.25
    if area_ratio > 2.0:
        fit -= min(0.30, 0.15 * math.log2(area_ratio))
    if inside_fraction < 0.50:
        fit -= 0.20
    if edge_touches >= 2:
        fit -= 0.10
    prior_quality_ok = reliability < 0.35 or (foreground_agreement >= 0.62 and foreground_coverage >= 0.25)
    status = "pass" if fit >= 0.56 and inside_fraction >= 0.72 and 0.008 <= area_ratio <= 1.35 and prior_quality_ok else "review"
    return {
        "model_score": round(score, 6),
        "selection_fit": round(fit, 6),
        "bbox_iou_with_prompt": round(overlap, 6),
        "mask_inside_prompt": round(inside_fraction, 6),
        "prompt_coverage": round(coverage, 6),
        "mask_to_prompt_area": round(area_ratio, 6),
        "mask_pixels": mask_area,
        "foreground_agreement": round(foreground_agreement, 6),
        "foreground_coverage": round(foreground_coverage, 6),
        "background_leakage": round(background_leakage, 6),
        "prior_reliability": round(reliability, 6),
        "source": source,
        "auto_status": status,
    }


def refined_alpha(mask: np.ndarray, probability: np.ndarray | None = None) -> np.ndarray:
    labels, count = ndimage.label(mask)
    cleaned = mask.copy()
    if count:
        sizes = np.bincount(labels.ravel())
        minimum = max(5, round(mask.size * 0.000012))
        keep = sizes >= minimum
        keep[0] = False
        cleaned = keep[labels]
    # Do not fill holes: facial openings and feather gaps are meaningful negative space.
    edge = ndimage.gaussian_filter(cleaned.astype(np.float32), sigma=0.65)
    alpha = np.clip((edge - 0.08) / 0.84, 0.0, 1.0)
    if probability is not None:
        confidence = np.clip((probability - 0.22) / 0.32, 0.0, 1.0)
        alpha = np.maximum(alpha * 0.82, confidence * cleaned)
    return np.round(alpha * 255).astype(np.uint8)


def image_data_url(image: Image.Image, *, max_side: int | None = None) -> str:
    value = image
    if max_side and max(value.size) > max_side:
        value = ImageOps.contain(value, (max_side, max_side), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    value.save(output, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def make_preview(image: Image.Image, mask: np.ndarray, prompt: list[float], predicted: list[float], rank: int, source: str) -> Image.Image:
    base = np.asarray(image.convert("RGB"), dtype=np.float32)
    color = np.array([19, 194, 183], dtype=np.float32)
    base[mask] = base[mask] * 0.48 + color * 0.52
    result = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), mode="RGB")
    draw = ImageDraw.Draw(result)
    line = max(3, round(min(result.size) / 240))
    draw.rectangle(prompt, outline=(226, 165, 63), width=line)
    draw.rectangle(predicted, outline=(20, 220, 205), width=line)
    label = f"{source.upper()} / {rank:02d}"
    draw.rectangle((12, 12, 164, 42), fill=(18, 35, 38))
    draw.text((22, 20), label, fill=(250, 246, 232))
    return result


def segment(pattern_id: str, box: list[float], mode: str = "single", include_images: bool = True) -> dict[str, Any]:
    pattern = PATTERNS.get(pattern_id.upper())
    if pattern is None:
        raise KeyError(f"未登记的纹样编号：{pattern_id}")
    image_path = (IMAGE_ROOT / f"{pattern_id.upper()}.png").resolve()
    if image_path.parent != IMAGE_ROOT.resolve() or not image_path.exists():
        raise FileNotFoundError(f"纹样原图不存在：{pattern_id}")
    source_image = Image.open(image_path)
    if "A" in source_image.getbands():
        source_rgba = source_image.convert("RGBA")
        source_alpha = np.asarray(source_rgba.getchannel("A"), dtype=np.uint8)
        source_valid = source_alpha > 8
        # PIL's direct RGBA -> RGB conversion turns transparent pixels black.
        # A neutral canvas prevents those synthetic black regions from becoming masks.
        neutral = Image.new("RGBA", source_rgba.size, (255, 255, 255, 255))
        image = Image.alpha_composite(neutral, source_rgba).convert("RGB")
    else:
        image = source_image.convert("RGB")
        source_valid = np.ones((image.height, image.width), dtype=bool)
    width, height = image.size
    prompt_pixels = pixel_box(box, width, height)
    foreground, gate, prior = foreground_prior(image, prompt_pixels)
    processor, torch = load_model()
    started = time.perf_counter()
    with INFERENCE_LOCK, torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        processor.set_confidence_threshold(0.25)
        state = processor.set_image(image)
        state = processor.add_geometric_prompt(box=normalized_cxcywh(box), label=True, state=state)
        threshold = 0.25
        for fallback in (0.10, 0.03):
            if len(state["scores"]) > 0:
                break
            state = processor.set_confidence_threshold(fallback, state)
            threshold = fallback
    scores = state["scores"].detach().float().cpu().numpy().reshape(-1)
    boxes = state["boxes"].detach().float().cpu().numpy().reshape(-1, 4)
    masks = state["masks"].detach().float().cpu().numpy().astype(bool)
    probabilities = state["masks_logits"].detach().float().cpu().numpy()
    if masks.ndim == 4:
        masks = masks[:, 0]
    if probabilities.ndim == 4:
        probabilities = probabilities[:, 0]
    if len(scores) == 0:
        del state
        gc.collect()
        torch.cuda.empty_cache()
        raise RuntimeError("当前框选区域没有找到候选纹样元，请扩大或移动框选范围。")

    candidates: list[dict[str, Any]] = []

    def add_candidate(source: str, mask: np.ndarray, model_score: float, probability: np.ndarray | None) -> None:
        candidate_mask = mask.astype(bool) & source_valid
        if mode == "single":
            candidate_mask = stabilize_single_mask(candidate_mask)
        if int(candidate_mask.sum()) < max(8, round(gate.sum() * 0.002)):
            return
        candidate_box = mask_box(candidate_mask)
        metrics = candidate_metrics(candidate_mask, candidate_box, model_score, prompt_pixels, foreground, gate, prior, source)
        candidate = {"source": source, "box": candidate_box, "mask": candidate_mask, "probability": probability, "metrics": metrics}
        for index, existing in enumerate(candidates):
            intersection = int((candidate_mask & existing["mask"]).sum())
            union = int((candidate_mask | existing["mask"]).sum())
            if intersection / max(union, 1) > 0.975:
                if float(metrics["selection_fit"]) > float(existing["metrics"]["selection_fit"]):
                    candidates[index] = candidate
                return
        candidates.append(candidate)

    for index, (score, predicted, mask) in enumerate(zip(scores, boxes, masks, strict=True)):
        constrained = mask & gate if mode == "single" else mask
        add_candidate("sam3", constrained, float(score), probabilities[index])
        if prior["prior_reliability"] >= 0.12:
            add_candidate("hybrid", constrained & foreground, float(score), probabilities[index])
    # A colour-only mask is safe as a selectable candidate only when the crop
    # border strongly agrees on a background material. On busy borders it remains
    # a weak scoring hint for SAM3, but is never promoted as a standalone answer.
    if foreground.any() and float(prior["border_background"]) >= 0.92:
        prior_score = 0.62 + 0.32 * float(prior["prior_reliability"])
        add_candidate("foreground", foreground, prior_score, None)
    if not candidates:
        # The prompt can occasionally fall mostly on a transparent part of an
        # irregular source PNG. Return a conservative, visibly review-only
        # fallback instead of surfacing an internal-server error.
        fallback = foreground & source_valid & gate
        if int(fallback.sum()) < max(8, round(gate.sum() * 0.002)):
            fallback = source_valid & gate
        add_candidate("foreground", fallback, 0.15, None)
        if candidates:
            candidates[0]["metrics"]["auto_status"] = "review"
    candidates.sort(key=lambda item: float(item["metrics"]["selection_fit"]), reverse=True)

    response_candidates = []
    for rank, candidate in enumerate(candidates[:3], start=1):
        mask = candidate["mask"]
        predicted = candidate["box"]
        public_metrics = dict(candidate["metrics"])
        public_metrics["selection_fit"] = round(min(float(public_metrics["selection_fit"]), 0.99), 6)
        preview_data_url = ""
        cutout_data_url = ""
        if include_images:
            alpha = refined_alpha(mask, candidate["probability"])
            alpha_image = Image.fromarray(alpha, mode="L")
            content_box = alpha_image.getbbox()
            if content_box is None:
                continue
            margin = max(8, round(min(width, height) * 0.012))
            crop_box = (
                max(0, content_box[0] - margin),
                max(0, content_box[1] - margin),
                min(width, content_box[2] + margin),
                min(height, content_box[3] + margin),
            )
            rgba = image.convert("RGBA")
            rgba.putalpha(alpha_image)
            cutout = rgba.crop(crop_box)
            preview_data_url = image_data_url(make_preview(image, mask, prompt_pixels, predicted, rank, candidate["source"]), max_side=920)
            cutout_data_url = image_data_url(cutout)
        response_candidates.append({
            "rank": rank,
            "source": candidate["source"],
            "score": candidate["metrics"]["model_score"],
            "fit": public_metrics["selection_fit"],
            "status": candidate["metrics"]["auto_status"],
            "bbox_xyxy": [round(value, 2) for value in predicted],
            "bbox_norm": [round(predicted[0] / width, 6), round(predicted[1] / height, 6), round(predicted[2] / width, 6), round(predicted[3] / height, 6)],
            "metrics": public_metrics,
            "preview_data_url": preview_data_url,
            "cutout_data_url": cutout_data_url,
            "filename": f"{pattern_id.upper()}_sam3_candidate_{rank}.png",
        })
    if not response_candidates:
        raise RuntimeError("候选蒙版未形成有效透明纹样元，请调整框选范围后重试。")
    elapsed = time.perf_counter() - started
    del state, masks, probabilities, candidates
    gc.collect()
    torch.cuda.empty_cache()
    LOGGER.info("Segmented %s in %.2fs (%d candidates)", pattern_id.upper(), elapsed, len(response_candidates))
    return {
        "pattern_id": pattern_id.upper(),
        "image_size": [width, height],
        "prompt_box": box,
        "mode": mode,
        "foreground_prior": prior,
        "threshold_used": threshold,
        "inference_seconds": round(elapsed, 3),
        "candidates": response_candidates,
    }


def health_payload() -> dict[str, Any]:
    runtime_ok = all(path.exists() for path in (SAM3_ROOT / "sam3", CHECKPOINT, PATTERNS_PATH))
    payload: dict[str, Any] = {
        "service": "xiuwen-sam3",
        "status": "ok" if runtime_ok and MODEL_STATE != "error" else "error",
        "model_state": MODEL_STATE,
        "patterns": len(PATTERNS),
        "local_only": True,
    }
    if MODEL_LOAD_SECONDS is not None:
        payload["model_load_seconds"] = round(MODEL_LOAD_SECONDS, 3)
    if MODEL_ERROR:
        payload["message"] = MODEL_ERROR
    elif not runtime_ok:
        payload["message"] = "SAM3 本地运行文件不完整。"
    return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "XiuwenSAM3/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), fmt % args)

    def cors_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        allowed = origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:")
        self.send_header("Access-Control-Allow-Origin", origin if allowed else "http://127.0.0.1:5173")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/sam3/health":
            self.send_json(HTTPStatus.OK, health_payload())
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})

    def do_POST(self) -> None:
        if self.path != "/api/sam3/segment":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError("请求内容为空或过大。")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            pattern_id = str(payload.get("pattern_id", "")).strip().upper()
            if not pattern_id:
                raise ValueError("缺少 pattern_id。")
            mode = str(payload.get("mode", "single"))
            if mode not in {"single", "motif"}:
                raise ValueError("mode 必须是 single 或 motif。")
            include_images = payload.get("include_images", True) is not False
            result = segment(pattern_id, clamp_normalized_box(payload.get("box")), mode, include_images)
            self.send_json(HTTPStatus.OK, result)
        except (ValueError, KeyError, FileNotFoundError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error).strip("'")})
        except Exception as error:
            LOGGER.exception("Segmentation request failed")
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error) or "SAM3 推理失败。"})


def main() -> int:
    try:
        require_runtime()
        load_pattern_index()
    except Exception:
        LOGGER.exception("SAM3 service preflight failed")
        return 1
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    LOGGER.info("SAM3 service listening at http://%s:%d (%d patterns)", HOST, PORT, len(PATTERNS))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

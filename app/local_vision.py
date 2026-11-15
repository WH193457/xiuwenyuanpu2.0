"""Local reference-image observations using Qwen2-VL in an isolated worker.

The caller serializes GPU tasks and releases its image-generation pipeline first.
The worker uses pinned local packages and exits after inference to release memory.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
MODEL_NAME = "Qwen/Qwen2-VL-2B-Instruct"
MODEL_REVISION = "895c3a49bc3fa70a340399125c650a463535e71c"
MODEL_DIRECTORY = Path(os.environ.get("XIUWEN_VISION_MODEL", str(PROJECT_ROOT / ".model-cache" / "Qwen2-VL-2B-Instruct")))
RUNTIME_DIRECTORY = PROJECT_ROOT / ".model-runtime" / "vision"
REFERENCE_DIRECTORY = PROJECT_ROOT / "outputs" / "references"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
VISION_PROMPT_VERSION = "dong-tobest-1"
TOBEST_FIELDS = ("theme", "object", "background", "emotion", "style", "technique")
OBSERVATION_FIELDS = {
    "subject": ("subject", "图像主体"),
    "object": ("subject", "图像主体"),
    "composition": ("composition", "图像构图"),
    "background": ("composition", "图像背景"),
    "palette": ("palette", "图像色彩"),
    "theme": ("intention", "视觉主题建议"),
    "emotion": ("intention", "情绪建议"),
    "style": ("style", "视觉风格"),
    "technique": ("technique", "可见纹理"),
}
# Locally authored TOBEST adaptation and schema example for the available model.
# The paper's full prompts and its fine-tuned model were not supplied.
REFERENCE_INSTRUCTION = (
    "Inspect this reference image for a pattern designer using six TOBEST dimensions: "
    "theme, object, background, emotion, style, technique. "
    "Also record composition and palette as visual dimensions for embroidery design. "
    "Separate the foreground motif from its frame, background, and printed captions. "
    "Do not infer ethnicity, historical origin, cultural meaning, or symbolic significance. "
    "theme: a broad visual subject category directly supported by the image, or an empty string. "
    "object: visible foreground shapes and parts; describe the silhouette when identity is ambiguous. "
    "background: visible backdrop around the motif, or an empty string when not observable. "
    "emotion: a tentative visible mood only when clearly expressed; otherwise an empty string. "
    "style: observable visual treatment. technique: visible surface or edge texture; avoid guessing production methods. "
    "composition: visible arrangement and direction. palette: main visible colors. "
    "Return only one JSON object with exactly these eight keys and concise English string values. "
    "Use empty strings for unknown or not visually observable dimensions. "
    "The following locally authored example illustrates the format for a hypothetical blue circle. "
    "Its contents must not be copied unless they match the actual image: "
    '{"theme":"abstract geometric design","object":"a blue circular motif",'
    '"background":"plain ivory background","emotion":"","style":"flat graphic design",'
    '"technique":"","composition":"one centered circle","palette":"blue and ivory"}. '
    "Now analyze only the supplied image and return its observations."
)


def vision_available() -> bool:
    required = ["config.json", "preprocessor_config.json", "tokenizer.json", "model.safetensors.index.json"]
    if not all((MODEL_DIRECTORY / name).is_file() for name in required):
        return False
    try:
        index = json.loads((MODEL_DIRECTORY / "model.safetensors.index.json").read_text(encoding="utf-8"))
        shards = set(index["weight_map"].values())
        return bool(shards) and all((MODEL_DIRECTORY / shard).is_file() for shard in shards) and (RUNTIME_DIRECTORY / "transformers" / "__init__.py").is_file()
    except (OSError, ValueError, KeyError, TypeError):
        return False


def vision_status() -> dict[str, Any]:
    return {"available": vision_available(), "model": MODEL_NAME, "revision": MODEL_REVISION, "local_only": True}


def decode_reference(data_url: Any) -> tuple[Any, str]:
    from PIL import Image, ImageOps, UnidentifiedImageError

    if not isinstance(data_url, str) or len(data_url) > MAX_IMAGE_BYTES * 4 // 3 + 100:
        raise ValueError("参考图需为不超过8MB的PNG、JPEG或WebP图片。")
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)", data_url)
    if not match:
        raise ValueError("参考图需要PNG、JPEG或WebP的base64数据。")
    try:
        raw = base64.b64decode(match.group(2).replace("\r", "").replace("\n", ""), validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("参考图编码无效。") from error
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("参考图需为不超过8MB的图片。")
    try:
        image = Image.open(io.BytesIO(raw))
        if image.format not in {"PNG", "JPEG", "WEBP"}:
            raise ValueError("参考图格式需要为PNG、JPEG或WebP。")
        if image.width * image.height > MAX_IMAGE_PIXELS or min(image.size) < 16:
            raise ValueError("参考图边长需至少16像素，总像素不超过1600万。")
        image.load()
        image = ImageOps.exif_transpose(image)
        if "A" in image.getbands():
            background = Image.new("RGBA", image.size, "white")
            image = Image.alpha_composite(background, image.convert("RGBA"))
        image = image.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError("参考图无法解码，请重新选择图片。") from error
    return image, hashlib.sha256(raw).hexdigest()


def _extract_reference_observations(raw_text: str, reference_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(raw_text, str):
        raise ValueError("本地图像模型返回的观察格式无效。")
    start, end = raw_text.find("{"), raw_text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("本地图像模型未返回可用的结构化观察，请重新分析或手动编辑概念。")
    try:
        observations = json.loads(raw_text[start:end + 1])
    except json.JSONDecodeError as error:
        raise ValueError("本地图像模型返回的观察格式不完整，请重新分析。") from error
    if not isinstance(observations, dict):
        raise ValueError("本地图像模型返回的观察格式无效。")
    # Small local models sometimes nest named dimensions inside another dimension.
    # Recover named dimensions while retaining old five-dimension responses.
    pending = [observations]
    dimension_values = {}
    while pending:
        current = pending.pop(0)
        if isinstance(current, dict):
            for name, value in current.items():
                if name in OBSERVATION_FIELDS and name not in dimension_values:
                    dimension_values[name] = value
                if isinstance(value, (dict, list)):
                    pending.append(value)
        elif isinstance(current, list):
            pending.extend(item for item in current if isinstance(item, (dict, list)))
    concepts = []
    normalized = {name: [] for name in (*TOBEST_FIELDS, "composition", "palette")}
    for field, (dimension, dimension_label) in OBSERVATION_FIELDS.items():
        items = dimension_values.get(field, [])
        if isinstance(items, (dict, str)):
            items = [items]
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items[:2]):
            if isinstance(item, str):
                item = {"label": item, "text": item}
            if not isinstance(item, dict):
                continue
            english = item.get("text")
            label = item.get("label", english)
            if not isinstance(label, str) or not isinstance(english, str):
                continue
            label = " ".join(label.split())[:120]
            english = " ".join(english.split())[:240]
            if not label or not re.search(r"[A-Za-z]", english) or re.search(r"[\u3400-\u9fff]", english):
                continue
            if re.fullmatch(
                r"(?:unknown|unclear|uncertain|none|null|n/?a|not applicable|not (?:visually )?"
                r"(?:observable|visible|discernible|clear|known)|cannot (?:be )?(?:determined|identified|determine|identify))"
                r"(?: (?:object|subject|theme|background|emotion|style|technique|composition|palette))?[.!]?",
                english, flags=re.IGNORECASE,
            ):
                continue
            concept = {
                "id": f"vision:{reference_id}:{field}:{index}",
                "dimension": dimension,
                "label": f"{dimension_label} · {label}",
                "promptText": english,
                "priority": 3 if dimension == "subject" else 2,
                "enabled": field not in {"theme", "emotion"},
                "patternIds": [],
                "sourceIds": [],
                "evidence": "user",
            }
            concepts.append(concept)
            normalized["object" if field == "subject" else field].append({
                "label": label, "text": english, "concept_id": concept["id"],
                "input_field": field, "enabled": concept["enabled"],
            })
    if not concepts or not any(concept["dimension"] == "subject" for concept in concepts):
        raise ValueError("本地图像模型未形成可用的主体观察，请重试或手动填写。")
    return {"version": 1, "concepts": concepts, "extraPrompt": ""}, normalized


def extract_observations(raw_text: str, reference_id: str) -> dict[str, Any]:
    plan, _ = _extract_reference_observations(raw_text, reference_id)
    return plan


def analyze_reference(image_data_url: Any) -> dict[str, Any]:
    image, digest = decode_reference(image_data_url)
    if not vision_available():
        raise FileNotFoundError("本地图像分析模型尚未准备完成，请先运行scripts/setup-local-vision.ps1。")
    started = time.monotonic()
    reference_id = f"REF-{digest[:16]}"
    REFERENCE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    image_path = REFERENCE_DIRECTORY / f"{reference_id}.png"
    # Normalized RGB input strips EXIF and remains a reproducible local reference.
    if not image_path.exists():
        temporary = image_path.with_suffix(f".{os.getpid()}.png.tmp")
        image.save(temporary, format="PNG")
        temporary.replace(image_path)
    environment = os.environ.copy()
    environment.update({
        "HF_HOME": str(PROJECT_ROOT / ".model-cache" / "hf"),
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false", "PYTHONUTF8": "1",
    })
    try:
        completed = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", str(Path(__file__).resolve()), "--worker", str(image_path)],
            capture_output=True, text=True, encoding="utf-8", timeout=180, env=environment,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("本地图像分析超过180秒，请使用较简单的参考图后重试。") from error
    if completed.returncode:
        detail = completed.stderr.strip().splitlines()
        raise RuntimeError(f"本地图像分析失败。{detail[-1][:300] if detail else '请检查模型与显存。'}")
    try:
        response = json.loads(completed.stdout)
        raw_text = response["text"]
    except (ValueError, KeyError, TypeError) as error:
        raise RuntimeError("本地图像分析返回异常，请重试。") from error
    try:
        plan, normalized_observations = _extract_reference_observations(raw_text, reference_id)
    except ValueError as error:
        failure = {
            "model": MODEL_NAME, "model_revision": MODEL_REVISION,
            "reference_id": reference_id, "raw_observation": raw_text,
            "observation_schema": VISION_PROMPT_VERSION,
            "error": str(error), "elapsed_seconds": round(time.monotonic() - started, 2),
        }
        (REFERENCE_DIRECTORY / f"{reference_id}-analysis-error.json").write_text(
            json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        raise
    result = {
        "semantic_plan": plan,
        "model": MODEL_NAME,
        "model_revision": MODEL_REVISION,
        "observation_schema": VISION_PROMPT_VERSION,
        "tobest_observations": {name: normalized_observations[name] for name in TOBEST_FIELDS},
        "visual_extensions": {name: normalized_observations[name] for name in ("composition", "palette")},
        "elapsed_seconds": round(time.monotonic() - started, 2),
        "warnings": ["这些概念来自本地图像模型的视觉观察，请核对主体、颜色和构图后采纳。文化寓意需另行依据资料确认。",
                     "视觉主题与情绪建议默认停用，可在核对后手动启用。"],
        "reference": {"id": reference_id, "sha256": digest, "width": image.width, "height": image.height, "path": str(image_path)},
        "raw_observation": raw_text,
    }
    metadata_path = REFERENCE_DIRECTORY / f"{reference_id}-analysis.json"
    temporary_metadata = metadata_path.with_suffix(".json.tmp")
    temporary_metadata.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_metadata.replace(metadata_path)
    return result


def run_worker(image_path: str) -> str:
    os.environ.setdefault("HF_HOME", str(PROJECT_ROOT / ".model-cache" / "hf"))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    sys.path.insert(0, str(RUNTIME_DIRECTORY))
    import torch
    from PIL import Image
    from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    processor = AutoProcessor.from_pretrained(
        str(MODEL_DIRECTORY), local_files_only=True,
        min_pixels=128 * 28 * 28, max_pixels=512 * 28 * 28,
    )
    model = Qwen2VLForConditionalGeneration.from_pretrained(
        str(MODEL_DIRECTORY), local_files_only=True, torch_dtype=dtype,
        attn_implementation="sdpa", low_cpu_mem_usage=True,
    ).to(device).eval()
    image = Image.open(image_path).convert("RGB")
    messages = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": REFERENCE_INSTRUCTION}]}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=[image], padding=True, return_tensors="pt").to(device)
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=768, do_sample=False)
    return processor.batch_decode(output[:, inputs.input_ids.shape[1]:], skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--worker":
        raise SystemExit("Use the local /api/lora/analyze-reference endpoint.")
    print(json.dumps({"text": run_worker(sys.argv[2])}, ensure_ascii=False))

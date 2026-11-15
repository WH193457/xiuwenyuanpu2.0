"""本地侗族纹样 LoRA 生成服务（SD1.5 + dongzu_embroidery_v2）。

默认监听 http://127.0.0.1:8001
  GET  /api/lora/health
  POST /api/lora/preview
  POST /api/lora/generate
  POST /api/lora/refine
  POST /api/lora/compose
  POST /api/lora/analyze-reference
  POST /api/lora/prepare-reference
"""

from __future__ import annotations

import base64
from collections import OrderedDict
from contextlib import contextmanager
import gc
import importlib.util
import io
import json
import logging
import math
import os
import re
import socket
import threading
import time
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from prompt_plan import COMPILER_VERSION, compile_plan, english_clause, normalize_english, token_count, validate_plan
from local_language import COMPOSITION_METHOD, compose_plan, language_status, refine_plan
from generation_policy import PROFILES, fidelity_conditioning, generation_profile

PROJECT_ROOT = Path(__file__).resolve().parent
AIGC_ROOT = PROJECT_ROOT.parent
LORA_ROOT = Path(os.environ.get("LORA_SCRIPTS_ROOT", str(AIGC_ROOT / "lora-scripts-main"))).resolve()
BASE_MODEL = Path(
    os.environ.get("LORA_BASE_MODEL", str(LORA_ROOT / "sd-models" / "v1-5-pruned-emaonly.safetensors"))
).resolve()
LORA_WEIGHTS = Path(
    os.environ.get("LORA_WEIGHTS", str(LORA_ROOT / "output" / "dongzu_embroidery_v2.safetensors"))
).resolve()
HOST = os.environ.get("LORA_SERVICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("LORA_SERVICE_PORT", "8001"))
OUTPUT_ROOT = PROJECT_ROOT / "outputs" / "lora"
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
SUPPLEMENT_TRANSLATIONS: OrderedDict[str, dict[str, str]] = OrderedDict()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(OUTPUT_ROOT / "lora-service.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
LOGGER = logging.getLogger("lora-service")

MODEL_LOCK = threading.Lock()
INFERENCE_LOCK = threading.Lock()
STATUS_LOCK = threading.Lock()
ACTIVE_TASK: str | None = None
QUEUED_TASKS = 0
MODEL_STATE = "cold"
MODEL_ERROR: str | None = None
MODEL_LOAD_SECONDS: float | None = None
PIPE: Any = None
TORCH: Any = None
TOKENIZER: Any = None
TOKENIZER_CHECKED = False
TOKENIZER_LOCK = threading.Lock()
ADAPTER_NAME = "dongzu"
CONTROL_PIPE: Any = None
IMAGE_PIPE: Any = None
CONTROLNET_DIRECTORY = Path(os.environ.get("XIUWEN_CONTROLNET_MODEL", str(PROJECT_ROOT / ".model-cache" / "control_v11p_sd15_canny"))).resolve()
CONTROLNET_NAME = "lllyasviel/control_v11p_sd15_canny"
CONTROLNET_REVISION = "115a470d547982438f70198e353a921996e2e819"
EMBROIDERY_PROMPT = "close-up embroidery photograph, raised parallel silk stitches, individual thread fibers, woven cotton fabric"


@contextmanager
def model_task(name: str):
    """All image, language and vision loading shares the same GPU reservation."""
    global ACTIVE_TASK, QUEUED_TASKS
    with STATUS_LOCK:
        QUEUED_TASKS += 1
    with INFERENCE_LOCK:
        with STATUS_LOCK:
            QUEUED_TASKS -= 1
            ACTIVE_TASK = name
        try:
            yield
        finally:
            with STATUS_LOCK:
                ACTIVE_TASK = None


def unload_pipeline() -> None:
    global PIPE, CONTROL_PIPE, IMAGE_PIPE, MODEL_STATE, MODEL_ERROR
    with MODEL_LOCK:
        previous = (PIPE, CONTROL_PIPE, IMAGE_PIPE)
        PIPE = None
        CONTROL_PIPE = None
        IMAGE_PIPE = None
        MODEL_STATE = "cold"
        MODEL_ERROR = None
        del previous
        gc.collect()
        if TORCH is not None and TORCH.cuda.is_available():
            TORCH.cuda.empty_cache()

PALETTE_HINTS = {
    "沿用母纹": "traditional ethnic embroidery colors",
    "古绢朱青": "vermilion and celadon on aged silk",
    "墨褐单色": "monochrome ink brown embroidery",
    "低饱和转译": "muted low saturation contemporary palette",
}
COMPOSITION_HINTS = {
    "中心式": "centered composition",
    "带状连续": "horizontal band repeating pattern",
    "满铺式": "full-bleed repeating textile pattern",
    "放射式": "radial symmetric composition",
}
INTENTION_HINTS = {
    "秩序与延续": "order continuity tradition",
    "群体与共生": "community coexistence motif",
    "自然与守护": "nature protection auspicious symbolism",
    "纯视觉实验": "pure visual experiment geometric abstraction",
}

SUBJECT_HINTS: list[tuple[tuple[str, ...], str]] = [
    (("凤", "凤凰", "phoenix"), "phoenix bird motif, clear animal silhouette, recognizable phoenix head wings and tail feathers"),
    (("龙", "蛟", "dragon"), "dragon motif, clear animal silhouette, recognizable dragon head horns and body"),
    (("蝶", "蝴蝶", "butterfly"), "butterfly motif, clear insect silhouette, paired wings and antennae"),
    (("鸟", "雀", "鸡", "bird"), "bird motif, clear animal silhouette, recognizable beak wings and tail"),
    (("鱼", "虾", "fish"), "aquatic animal motif, clear silhouette, recognizable fish or shrimp form"),
    (("狮", "虎", "兽", "lion"), "mythical beast motif, clear animal silhouette"),
    (("花", "卉", "牡丹", "莲", "菊", "floral", "flower"), "floral plant motif, clear blossom silhouette, recognizable petals and leaves"),
    (("树", "叶", "藤", "草"), "plant vine motif, clear botanical silhouette"),
    (("日", "月", "星", "云", "sun", "moon"), "celestial nature motif, sun moon cloud forms"),
    (("几何", "边饰", "菱", "回纹", "万字"), "geometric lattice motif, diamond repeat, embroidery border band"),
    (("人", "娃", "舞"), "human figure motif, clear silhouette, folk scene"),
]

NEGATIVE_PROMPT = (
    "blurry, photo, photograph, watercolor, painting, soft focus, deformed animal, "
    "mutated body, extra limbs, extra heads, unrecognizable creature, messy anatomy, "
    "watermark, text, logo, low quality, distorted, 3d render, human face close-up, "
    "modern city, messy background, jpeg artifacts, noise"
)


def require_runtime() -> None:
    if not BASE_MODEL.exists():
        raise FileNotFoundError(f"未找到底模：{BASE_MODEL}")
    if not LORA_WEIGHTS.exists():
        raise FileNotFoundError(f"未找到 LoRA 权重：{LORA_WEIGHTS}")


def load_pipeline() -> Any:
    global MODEL_STATE, MODEL_ERROR, MODEL_LOAD_SECONDS, PIPE, TORCH
    if PIPE is not None:
        return PIPE

    with MODEL_LOCK:
        if PIPE is not None:
            return PIPE
        MODEL_STATE = "loading"
        MODEL_ERROR = None
        started = time.time()
        try:
            require_runtime()
            import torch
            from diffusers import StableDiffusionPipeline
            from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_lora_to_diffusers
            from safetensors.torch import load_file

            TORCH = torch
            LOGGER.info("Loading SD1.5 from %s", BASE_MODEL)
            pipe = StableDiffusionPipeline.from_single_file(
                str(BASE_MODEL),
                torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
                local_files_only=True,
                safety_checker=None,
                requires_safety_checker=False,
            )
            pipe.to("cuda" if torch.cuda.is_available() else "cpu")
            try:
                pipe.enable_xformers_memory_efficient_attention()
            except Exception:
                LOGGER.info("xformers unavailable, continue without it")

            LOGGER.info("Loading LoRA %s", LORA_WEIGHTS)
            state = load_file(str(LORA_WEIGHTS))
            converted, alphas = _convert_non_diffusers_lora_to_diffusers(state)
            pipe.load_lora_into_unet(converted, network_alphas=alphas, unet=pipe.unet, adapter_name=ADAPTER_NAME)
            try:
                pipe.load_lora_into_text_encoder(
                    converted, network_alphas=alphas, text_encoder=pipe.text_encoder, adapter_name=ADAPTER_NAME
                )
            except Exception as error:
                LOGGER.warning("Text-encoder LoRA skipped: %s", error)

            PIPE = pipe
            MODEL_STATE = "ready"
            MODEL_LOAD_SECONDS = round(time.time() - started, 2)
            LOGGER.info("LoRA pipeline ready in %ss", MODEL_LOAD_SECONDS)
            return PIPE
        except Exception as error:
            MODEL_STATE = "error"
            MODEL_ERROR = str(error)
            LOGGER.exception("Failed to load LoRA pipeline")
            raise


def controlnet_available() -> bool:
    return (CONTROLNET_DIRECTORY / "config.json").is_file() and (CONTROLNET_DIRECTORY / "diffusion_pytorch_model.fp16.safetensors").is_file()


def load_reference_pipeline(method: str) -> Any:
    global CONTROL_PIPE, IMAGE_PIPE
    # The inference lock already serializes shared scheduler and LoRA updates.
    base = load_pipeline()
    with MODEL_LOCK:
        if method == "img2img":
            if IMAGE_PIPE is None:
                from diffusers import StableDiffusionImg2ImgPipeline
                IMAGE_PIPE = StableDiffusionImg2ImgPipeline.from_pipe(base)
            return IMAGE_PIPE
        if CONTROL_PIPE is None:
            if not controlnet_available():
                raise FileNotFoundError("本机ControlNet轮廓模型尚未安装，请运行scripts/setup-controlnet.py。")
            from diffusers import ControlNetModel, StableDiffusionControlNetImg2ImgPipeline
            controlnet = ControlNetModel.from_pretrained(str(CONTROLNET_DIRECTORY), local_files_only=True,
                variant="fp16", use_safetensors=True, torch_dtype=base.unet.dtype)
            controlnet.to(base.device)
            candidate = StableDiffusionControlNetImg2ImgPipeline.from_pipe(base, controlnet=controlnet)
            try:
                candidate.enable_xformers_memory_efficient_attention()
            except Exception:
                LOGGER.info("ControlNet xformers unavailable, using installed attention implementation")
            CONTROL_PIPE = candidate
        return CONTROL_PIPE


def prepared_conditioning(payload: dict[str, Any]) -> dict[str, Any] | None:
    value = payload.get("reference_conditioning")
    if value is None:
        return None
    from reference_conditioning import load_reference_conditioning
    return load_reference_conditioning(value)


def reference_description(reference: dict[str, Any]) -> dict[str, Any]:
    return {key: reference[key] for key in ("method", "strength", "control_scale", "embroidery_detail")} | {
        "reference_id": reference["metadata"]["reference_id"],
        "reference_sha256": reference["metadata"]["reference_sha256"],
    }


def prepare_reference(payload: dict[str, Any]) -> dict[str, Any]:
    from reference_conditioning import prepare_reference as prepare
    return prepare(payload)


def subject_hint(pattern_name: str, category: str, keywords: list[Any]) -> str:
    haystack = " ".join([pattern_name, category, *[str(item) for item in keywords if item]])
    for keys, hint in SUBJECT_HINTS:
        if any(key in haystack for key in keys):
            return hint
    if "动物" in category or "神兽" in category:
        return "clear animal silhouette, recognizable creature form, not abstract blob"
    if "几何" in category or "边饰" in category:
        return "geometric lattice motif, diamond repeat, embroidery border band"
    if "植物" in category or "花" in category:
        return "floral plant motif, clear blossom silhouette"
    return "clear primary motif silhouette, readable embroidery subject"


def build_prompt(payload: dict[str, Any]) -> tuple[str, str]:
    pattern_name = str(payload.get("pattern_name") or "Dong embroidery").replace("（暂定）", "")
    category = str(payload.get("category") or "")
    composition = str(payload.get("composition") or "中心式")
    palette = str(payload.get("palette") or "沿用母纹")
    intention = str(payload.get("intention") or "秩序与延续")
    keywords = payload.get("keywords") or []
    if not isinstance(keywords, list):
        keywords = []
    keyword_text = ", ".join(str(item) for item in keywords[:6] if item)
    motif = subject_hint(pattern_name, category, keywords)

    prompt = ", ".join(
        part
        for part in [
            "dongzu",
            "dong embroidery pattern",
            motif,
            pattern_name,
            category,
            COMPOSITION_HINTS.get(composition, composition),
            PALETTE_HINTS.get(palette, palette),
            INTENTION_HINTS.get(intention, intention),
            keyword_text,
            "traditional chinese minority textile motif",
            "intricate embroidery, crisp stitches, clean flat pattern, high detail, sharp focus",
        ]
        if part
    )
    return prompt, NEGATIVE_PROMPT


def cached_tokenizer() -> Any:
    """Use only local tokenizer files. Preview never initializes the image model."""
    global TOKENIZER, TOKENIZER_CHECKED
    pipeline = PIPE
    if pipeline is not None:
        return pipeline.tokenizer
    with TOKENIZER_LOCK:
        if TOKENIZER_CHECKED:
            return TOKENIZER
        TOKENIZER_CHECKED = True
        configured = os.environ.get("LORA_TOKENIZER_DIR")
        candidates = [Path(configured)] if configured else []
        cache = LORA_ROOT / "huggingface" / "hub" / "models--stable-diffusion-v1-5--stable-diffusion-v1-5" / "snapshots"
        candidates.extend(sorted(cache.glob("*/tokenizer")))
        for directory in candidates:
            if not (directory / "vocab.json").is_file() or not (directory / "merges.txt").is_file():
                continue
            try:
                from transformers import CLIPTokenizer

                TOKENIZER = CLIPTokenizer.from_pretrained(str(directory), local_files_only=True)
                break
            except Exception as error:
                LOGGER.warning("Local prompt tokenizer unavailable: %s", error)
        return TOKENIZER


def prepare_supplement(payload: dict[str, Any]) -> dict[str, Any]:
    """Translate only non-English supplemental text; leave all canvas concepts intact.

    The bounded process cache is accessed under the shared inference lock. Preview
    and generation thus reuse exactly the same translation without reloading Qwen.
    """
    if "semantic_plan" not in payload:
        return payload
    plan = validate_plan(payload["semantic_plan"])
    source = plan["extraPrompt"]
    if not source or english_clause(normalize_english(source)) or plan.get("extraPromptTranslation") or plan.get("promptRealization"):
        return {**payload, "semantic_plan": plan}
    with model_task("language"):
        translation = SUPPLEMENT_TRANSLATIONS.get(source)
        if translation is None:
            if not language_status()["available"]:
                raise FileNotFoundError("补充描述包含中文，本机语言模型尚未就绪。请启用本机语言模型，或暂时填写英文描述。")
            unload_pipeline()
            proposal = refine_plan({"version": 1, "concepts": [], "extraPrompt": source}, "")
            translation = {"sourceText": source, "text": proposal["semantic_plan"]["extraPrompt"], "model": proposal["model"]}
            # Do not cache malformed output or proceed with an untranslated request.
            translation = validate_plan({**plan, "extraPromptTranslation": translation})["extraPromptTranslation"]
            SUPPLEMENT_TRANSLATIONS[source] = translation
            while len(SUPPLEMENT_TRANSLATIONS) > 32:
                SUPPLEMENT_TRANSLATIONS.popitem(last=False)
        SUPPLEMENT_TRANSLATIONS.move_to_end(source)
        return {**payload, "semantic_plan": {**plan, "extraPromptTranslation": dict(translation)}}


def preview(payload: dict[str, Any]) -> dict[str, Any]:
    return preview_prompt(prepare_supplement(payload))


def preview_prompt(payload: dict[str, Any], tokenizer: Any = None) -> dict[str, Any]:
    profile = generation_profile(payload)
    reference = prepared_conditioning(payload)
    if reference is not None:
        validate_reference_dimensions(payload, reference)
    if reference is not None and "semantic_plan" not in payload:
        raise ValueError("结构参考生成需要提供semantic_plan，以便保留可追溯的创作条件。")
    if "semantic_plan" in payload:
        # Validate before any optional dependency import or model activity.
        plan = validate_plan(payload["semantic_plan"])
        selected_tokenizer = tokenizer if tokenizer is not None else cached_tokenizer()
        result = compile_plan(plan, selected_tokenizer, subject_first=profile == "subject-fidelity")
        result["generation_profile"] = profile
        if reference is not None:
            result["reference_conditioning"] = reference_description(reference)
            result["reference_preparation"] = reference["metadata"]
            if reference["embroidery_detail"]:
                enhanced = result["prompt"] + ", " + EMBROIDERY_PROMPT
                if selected_tokenizer is not None and token_count(selected_tokenizer, enhanced) > min(int(selected_tokenizer.model_max_length), 77):
                    raise ValueError("刺绣质感描述超出词元预算，请缩短画布条件或关闭增强针线质感后重试。")
                result["prompt"] = enhanced
                result["texture_prompt"] = EMBROIDERY_PROMPT
                result["prompt_token_count"] = token_count(selected_tokenizer, enhanced) if selected_tokenizer is not None else None
        if profile == "subject-fidelity":
            negative, policy = fidelity_conditioning(result, selected_tokenizer)
            if reference is not None:
                policy["spatial_control"] = reference["method"]
                policy["reference_preprocessor"] = reference["metadata"]["preprocessor"]
            result["negative_prompt"] = negative
            result["generation_policy"] = policy
            if policy["omitted_negative_terms"]:
                result["warnings"].append("部分负向条件超出CLIP预算，具体省略项已记入生成策略。")
        else:
            result["negative_prompt"] = NEGATIVE_PROMPT
            if reference is not None and reference["embroidery_detail"]:
                result["negative_prompt"] = ", ".join(term for term in NEGATIVE_PROMPT.split(", ") if term not in ("photo", "photograph"))
        return result
    prompt, negative = build_prompt(payload)
    return {
        "prompt": prompt,
        "negative_prompt": negative,
        "semantic_plan": None,
        "generation_profile": profile,
        "compiler_version": "dong-legacy-1",
        "warnings": [],
    }


def numeric_parameter(payload: dict[str, Any], name: str, default: float, low: float, high: float, integer: bool = False) -> float | int:
    value = payload.get(name)
    if value is None or value == "":
        value = default
    if isinstance(value, bool):
        raise ValueError(f"{name}需要为数值。")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"{name}需要为数值。") from error
    if not math.isfinite(number) or (integer and not number.is_integer()):
        raise ValueError(f"{name}需要为有限{'整数' if integer else '数值'}。")
    number = max(low, min(number, high))
    return int(number) if integer else number


def validate_reference_dimensions(payload: dict[str, Any], reference: dict[str, Any]) -> None:
    for field, expected in zip(("width", "height"), reference["image"].size):
        if field in payload and numeric_parameter(payload, field, expected, 384, 768, True) != expected:
            raise ValueError("生成尺寸与已确认的结构参考尺寸不同，请重新准备参考图。")


def generation_parameters(payload: dict[str, Any]) -> dict[str, Any]:
    generation_profile(payload)
    parameters = {
        "steps": numeric_parameter(payload, "steps", 30, 28, 32, True),
        "guidance": numeric_parameter(payload, "guidance", 7.2, 6.5, 8.0),
        "count": numeric_parameter(payload, "count", 3, 2, 4, True),
        "width": numeric_parameter(payload, "width", 512, 384, 768, True),
        "height": numeric_parameter(payload, "height", 512, 384, 768, True),
        "lora_scale": numeric_parameter(payload, "lora_scale", 1.0, 0.0, 1.0),
    }
    if parameters["width"] % 8 or parameters["height"] % 8:
        raise ValueError("图像宽高需要为8的倍数。")
    seed = payload.get("seed")
    if seed is None or seed == "":
        seed = uuid.uuid4().int % (2**32)
    try:
        parsed_seed = int(seed)
        valid_seed = not isinstance(seed, bool) and float(seed) == parsed_seed
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("随机种子需要为0至4294967295的整数。") from error
    if not valid_seed or not 0 <= parsed_seed < 2**32:
        raise ValueError("随机种子需要为0至4294967295的整数。")
    parameters["seed"] = parsed_seed
    return parameters


def write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def image_to_data_url(image: Any) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def generate_locked(payload: dict[str, Any], parameters: dict[str, Any]) -> dict[str, Any]:
    from structure_metrics import structure_metrics
    reference = prepared_conditioning(payload)
    if reference is not None:
        validate_reference_dimensions(payload, reference)
        expected_width, expected_height = reference["image"].size
        for field, expected in (("width", expected_width), ("height", expected_height)):
            parameters[field] = expected
    pipe = load_reference_pipeline(reference["method"]) if reference is not None else load_pipeline()
    compiled = preview_prompt(payload, pipe.tokenizer)
    prompt, negative = compiled["prompt"], compiled["negative_prompt"]
    negative_tokens = token_count(pipe.tokenizer, negative)
    if negative_tokens > pipe.tokenizer.model_max_length:
        compiled["warnings"].append("固定负向提示词超出CLIP预算，模型会使用其开头部分。")
    pattern_id = re.sub(r"[^A-Z0-9_-]", "_", str(payload.get("pattern_id") or "DX").upper())[:32] or "DX"
    run_id = f"LORA-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:12]}"
    output_directory = OUTPUT_ROOT / run_id
    output_directory.mkdir(parents=True, exist_ok=False)
    metadata_path = output_directory / "generation.json"
    metadata = {
        "id": run_id,
        "mode": "lora",
        "status": "running",
        "model": LORA_WEIGHTS.name,
        "base_model": BASE_MODEL.name,
        "pattern_id": payload.get("pattern_id"),
        "pattern_name": payload.get("pattern_name"),
        "carrier": payload.get("carrier"),
        "request_context": {key: payload.get(key) for key in (
            "composition", "palette", "intention", "element_id", "parent_result_id",
            "reference_id", "reference_name", "assistance",
        )},
        **compiled,
        **parameters,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "metadata_path": str(metadata_path),
        "candidates": [],
    }
    if reference is not None:
        metadata["conditioning_model"] = {"name": CONTROLNET_NAME, "revision": CONTROLNET_REVISION} if reference["method"] == "canny-img2img" else None
        metadata["postprocessing"] = "none"
    write_metadata(metadata_path, metadata)
    candidates: list[dict[str, Any]] = []
    try:
        if reference is not None:
            # Save the confirmed pixels as part of this run's failure-tracked work.
            for key, filename in (("image", "reference-init.png"), ("control_image", "reference-control.png"), ("mask_image", "reference-mask.png")):
                reference[key].save(output_directory / filename, format="PNG")
        pipe.set_adapters(ADAPTER_NAME, adapter_weights=parameters["lora_scale"])
        started = time.monotonic()
        for index in range(parameters["count"]):
            seed = (parameters["seed"] + index) % (2**32)
            generator = TORCH.Generator(device=pipe.device).manual_seed(seed)
            reference_kwargs = {}
            denoising_steps = 0
            if reference is not None:
                def count_step(_pipe, _index, _timestep, values):
                    nonlocal denoising_steps
                    denoising_steps += 1
                    return values
                reference_kwargs = {"image": reference["image"], "strength": reference["strength"],
                                    "callback_on_step_end": count_step}
                if reference["method"] == "canny-img2img":
                    reference_kwargs.update(control_image=reference["control_image"],
                                            controlnet_conditioning_scale=reference["control_scale"])
            result = pipe(
                prompt=prompt,
                negative_prompt=negative,
                num_inference_steps=parameters["steps"],
                guidance_scale=parameters["guidance"],
                width=parameters["width"],
                height=parameters["height"],
                generator=generator,
                **reference_kwargs,
            )
            image = result.images[0]
            file_path = output_directory / f"{pattern_id}-{index + 1}.png"
            temporary = file_path.with_suffix(".png.tmp")
            image.save(temporary, format="PNG")
            temporary.replace(file_path)
            metrics = structure_metrics(image, compiled.get("semantic_plan"), compiled.get("applied_concept_ids", []))
            candidate_metadata = {"seed": seed, "path": str(file_path), "structureMetrics": metrics}
            if reference is not None:
                candidate_metadata["denoisingSteps"] = denoising_steps
            metadata["candidates"].append(candidate_metadata)
            write_metadata(metadata_path, metadata)
            candidates.append({"image": image_to_data_url(image), **candidate_metadata})
        metadata["inference_seconds"] = round(time.monotonic() - started, 2)
        metadata["status"] = "complete"
        write_metadata(metadata_path, metadata)
    except Exception as error:
        metadata["status"] = "failed"
        metadata["error"] = str(error)
        write_metadata(metadata_path, metadata)
        raise
    finally:
        pipe.set_adapters(ADAPTER_NAME, adapter_weights=1.0)
    first = candidates[0]
    return {
        **metadata,
        "image_data_url": first["image"],
        "image_path": first["path"],
        "candidates": candidates,
    }


def generate(payload: dict[str, Any]) -> dict[str, Any]:
    parameters = generation_parameters(payload)
    payload = prepare_supplement(payload)
    preview_prompt(payload)
    with model_task("generation"):
        return generate_locked(payload, parameters)


def refine(payload: dict[str, Any]) -> dict[str, Any]:
    plan = validate_plan(payload.get("semantic_plan"))
    brief = payload.get("brief", "")
    if not isinstance(brief, str) or len(brief) > 1200:
        raise ValueError("中文创作描述需要是不超过1200字的文本。")
    with model_task("language"):
        unload_pipeline()
        return refine_plan(plan, brief)


def compose(payload: dict[str, Any]) -> dict[str, Any]:
    plan = validate_plan(payload.get("semantic_plan"))
    with model_task("language"):
        unload_pipeline()
        return compose_plan(plan)


def vision_capability() -> dict[str, Any]:
    if importlib.util.find_spec("local_vision") is None:
        return {"available": False, "model": "Qwen2-VL-2B-Instruct"}
    from local_vision import vision_status
    return vision_status()


def analyze_reference(payload: dict[str, Any]) -> dict[str, Any]:
    image = payload.get("image_data_url")
    if not isinstance(image, str) or len(image) > 12 * 1024 * 1024:
        raise ValueError("参考图片格式无效或超过8MB，请压缩后重试。")
    if not vision_capability()["available"]:
        raise FileNotFoundError("本地视觉语言模型尚未就绪，请完成模型配置后重试。")
    from local_vision import analyze_reference as analyze_image
    with model_task("vision"):
        unload_pipeline()
        return analyze_image(image)


def health_payload() -> dict[str, Any]:
    return {
        "service": "xiuwen-lora",
        "status": "ok" if MODEL_STATE != "error" else "error",
        "model_state": MODEL_STATE,
        "model_load_seconds": MODEL_LOAD_SECONDS,
        "message": MODEL_ERROR,
        "base_model": str(BASE_MODEL),
        "lora_weights": str(LORA_WEIGHTS),
        "cuda": bool(TORCH.cuda.is_available()) if TORCH is not None else None,
        "local_only": True,
        "runtime_available": BASE_MODEL.is_file() and LORA_WEIGHTS.is_file(),
        "semantic_preview": True,
        "compiler_version": COMPILER_VERSION,
        "generation_profiles": list(PROFILES),
        "reference_conditioning": {"available": controlnet_available(), "model": CONTROLNET_NAME,
            "revision": CONTROLNET_REVISION, "methods": ["img2img", "canny-img2img"]},
        "lora_scale": {"minimum": 0.0, "maximum": 1.0, "default": 1.0},
        "language": language_status(),
        "composition": {"available": language_status()["available"], "method": COMPOSITION_METHOD},
        "vision": vision_capability(),
        "active_task": ACTIVE_TASK,
        "queued_tasks": QUEUED_TASKS,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "XiuwenLoRA/1.0"

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
        if self.path.split("?")[0] == "/api/lora/health":
            self.send_json(HTTPStatus.OK, health_payload())
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})

    def do_POST(self) -> None:
        route = self.path.split("?")[0]
        if route not in ("/api/lora/generate", "/api/lora/preview", "/api/lora/refine", "/api/lora/compose", "/api/lora/analyze-reference", "/api/lora/prepare-reference"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            limit = 12 * 1024 * 1024 if route in ("/api/lora/analyze-reference", "/api/lora/prepare-reference") else 256 * 1024
            if length <= 0 or length > limit:
                raise ValueError("请求内容为空或过大。")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("请求内容需要为JSON对象。")
            actions = {"/api/lora/preview": preview, "/api/lora/generate": generate,
                       "/api/lora/refine": refine, "/api/lora/compose": compose, "/api/lora/analyze-reference": analyze_reference,
                       "/api/lora/prepare-reference": prepare_reference}
            result = actions[route](payload)
            self.send_json(HTTPStatus.OK, result)
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.info("Client disconnected after local model work")
        except (ValueError, FileNotFoundError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception as error:
            LOGGER.exception("LoRA generate failed")
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error) or "LoRA 生成失败。"})


class LocalThreadingHTTPServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can route traffic to a stale process on the same port.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> int:
    # Bind immediately so knowledge-plan preview works while the GPU model is cold.
    server = LocalThreadingHTTPServer((HOST, PORT), Handler)
    LOGGER.info("LoRA service listening at http://%s:%d", HOST, PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

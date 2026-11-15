"""On-device Qwen text refinement. The caller serializes GPU access."""

from __future__ import annotations

import gc
import json
import os
from pathlib import Path
import time
from typing import Any
import uuid

from prompt_plan import (bounded_text, english_clause, group_anchors, normalize_english,
                         plan_fingerprint, preserved_group_text, realization_groups, validate_group_text, validate_plan, validate_realization)

MODEL_NAME = "Qwen2-1.5B-Instruct"
COMPOSITION_METHOD = "full-canvas-conditioned-groups-qwen-v2"
MODEL_PATH = Path(os.environ.get("XIUVEN_LANGUAGE_MODEL", str(
    Path.home() / ".cache/huggingface/hub/models--Qwen--Qwen2-1.5B-Instruct/snapshots/ba1cf1846d7df0a0591d6c00649f57e798519da8"
)))
MODEL_STATE = "cold"
MODEL_ERROR: str | None = None
DESIGN_TERMS = {
    "朱红": "vermilion red", "靛蓝": "indigo blue", "乳白": "ivory white", "米白": "ivory",
    "平针刺绣": "flat-stitch embroidery", "中心对称": "centrally symmetric",
    "留白": "negative space", "边缘留白": "empty margins", "五角星": "five-pointed star",
    "银色": "silver", "钴蓝": "cobalt blue",
}


def language_status() -> dict[str, Any]:
    return {
        "available": all((MODEL_PATH / name).is_file() for name in ("config.json", "tokenizer.json", "model.safetensors")),
        "model": MODEL_NAME, "model_state": MODEL_STATE, "message": MODEL_ERROR,
    }


def parse_refinement(raw: str, plan: dict[str, Any], brief: str, aliases: dict[str, str] | None = None) -> dict[str, Any]:
    """Only accept translations for the original enabled IDs; retain all provenance."""
    start = raw.find("{")
    if start < 0:
        raise ValueError("本地语言模型未返回可读取的JSON，请重试或缩短创作描述。")
    try:
        parsed, _end = json.JSONDecoder().raw_decode(raw[start:])
    except json.JSONDecodeError as error:
        raise ValueError("本地语言模型的JSON不完整，请重试或缩短创作描述。") from error
    if not isinstance(parsed, dict) or not isinstance(parsed.get("translations"), list):
        raise ValueError("本地语言模型的翻译结构无效，请重试。")
    enabled_ids = {item["id"] for item in plan["concepts"] if item["enabled"]}
    translations = {}
    for row in parsed["translations"]:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise ValueError("本地语言模型改动了概念编号，请重试。")
        identifier = aliases.get(row["id"]) if aliases is not None else row["id"]
        if identifier not in enabled_ids or identifier in translations:
            raise ValueError("本地语言模型改动了概念编号，请重试。")
        text = normalize_english(bounded_text(row.get("promptText"), "模型英文描述", 240))
        if not english_clause(text):
            raise ValueError("本地语言模型返回了非英文条件，请重试。")
        translations[identifier] = text
    if set(translations) != enabled_ids:
        raise ValueError("本地语言模型遗漏了已启用的概念，请重试或分批整理条件。")
    extra = normalize_english(bounded_text(parsed.get("extraPrompt", ""), "模型补充描述", 1000))
    if (brief or plan["extraPrompt"]) and not english_clause(extra):
        raise ValueError("本地语言模型未能整理补充描述，请重试。")
    if not brief and not plan["extraPrompt"]:
        extra = ""
    refined = {
        **plan,
        "concepts": [{**item, "promptText": translations.get(item["id"], item["promptText"])} for item in plan["concepts"]],
        "extraPrompt": extra,
    }
    return validate_plan(refined)


def refine_plan(value: Any, brief_value: Any = "") -> dict[str, Any]:
    global MODEL_STATE, MODEL_ERROR
    plan = validate_plan(value)
    brief = bounded_text(brief_value, "中文创作描述", 1200)
    if not language_status()["available"]:
        raise FileNotFoundError("本地Qwen语言模型未安装，请配置XIUVEN_LANGUAGE_MODEL指向完整的本地模型目录。")
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    enabled = [{key: concept[key] for key in ("id", "label", "dimension", "promptText")} for concept in plan["concepts"] if concept["enabled"]]
    # Short request-local aliases avoid asking a small language model to copy UUIDs.
    # Only the strict one-to-one mapping below can restore the original identifiers.
    aliases = {f"c{index + 1}": concept["id"] for index, concept in enumerate(enabled)}
    for alias, concept in zip(aliases, enabled):
        concept["id"] = alias
    started = time.monotonic()
    model = tokenizer = inputs = output = None
    try:
        MODEL_STATE = "loading"
        MODEL_ERROR = None
        tokenizer = AutoTokenizer.from_pretrained(str(MODEL_PATH), local_files_only=True)
        use_cuda = torch.cuda.is_available()
        model = AutoModelForCausalLM.from_pretrained(
            str(MODEL_PATH), local_files_only=True,
            torch_dtype=torch.float16 if use_cuda else torch.float32,
            low_cpu_mem_usage=True, attn_implementation="sdpa",
        ).to("cuda" if use_cuda else "cpu")
        model.eval()
        MODEL_STATE = "running"
        fragments = list(enabled)
        if brief or plan["extraPrompt"]:
            fragments.append({"id": "c0", "label": ", ".join(filter(None, [brief, plan["extraPrompt"]])),
                              "dimension": "brief", "promptText": ""})
        translations = []
        extra = ""
        # Independent translations prevent attributes from bleeding between concepts.
        # The same loaded model serves every fragment and is released after the request.
        for fragment in fragments:
            source = fragment["label"]
            terms = {term: translation for term, translation in DESIGN_TERMS.items() if term in source}
            system = (
                "你是中英翻译器。把用户的text完整、准确翻译成简洁的英文视觉描述。"
                "保留全部数量、颜色、形状及动作。不要添加原文没有的内容，不解释历史文化。"
                "contextEnglish仅供参考，text优先。原文命中术语参考时须采用对应英文，保留具体色调。"
                "仅输出JSON，格式为{\"id\":\"原id\",\"promptText\":\"English translation\"}，复制id。"
            )
            if fragment["dimension"] == "intention":
                system += "这是一项设计意向，使用design intention of表达，不断言文化含义。"
            request = {"id": fragment["id"], "text": source, "contextEnglish": fragment["promptText"], "terminology": terms}
            messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(request, ensure_ascii=False)}]
            prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
            with torch.inference_mode():
                output = model.generate(
                    **inputs, do_sample=False, max_new_tokens=600 if fragment["id"] == "c0" else 180,
                    pad_token_id=tokenizer.eos_token_id, repetition_penalty=1.02,
                    temperature=1.0, top_p=1.0, top_k=50,
                )
            raw = tokenizer.decode(output[0, inputs.input_ids.shape[1]:], skip_special_tokens=True)
            start = raw.find("{")
            try:
                row, _end = json.JSONDecoder().raw_decode(raw[start:]) if start >= 0 else (None, 0)
            except json.JSONDecodeError as error:
                raise ValueError("本地语言模型的翻译格式不完整，请重试。") from error
            if not isinstance(row, dict) or row.get("id") != fragment["id"]:
                raise ValueError("本地语言模型改动了概念编号，请重试。")
            if fragment["id"] == "c0":
                extra = row.get("promptText", "")
            else:
                translations.append(row)
        refined = parse_refinement(json.dumps({"translations": translations, "extraPrompt": extra}), plan, brief, aliases)
        MODEL_STATE = "cold"
        return {
            "semantic_plan": refined, "model": MODEL_NAME,
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "warnings": ["这是本地语言模型整理的建议，请核对主体、色彩及文化意向后采用。"],
        }
    except Exception as error:
        MODEL_STATE = "error"
        MODEL_ERROR = str(error)
        raise
    finally:
        del output, inputs, model, tokenizer
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def composition_request(plan: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    groups = realization_groups(plan)
    if not groups:
        raise ValueError("请先启用至少一个概念或填写补充描述，再整理画布。")
    concept_aliases = {item["id"]: f"c{index + 1}" for index, item in enumerate(plan["concepts"])}
    aliases = {f"g{index + 1}": group for index, group in enumerate(groups)}
    canvas = []
    for item in plan["concepts"]:
        canvas.append({"id": concept_aliases[item["id"]], "dimension": item["dimension"],
                       "label": item["label"], "english": item["promptText"],
                       "priority": item["priority"], "enabled": item["enabled"],
                       "parentId": concept_aliases.get(item.get("parentId", ""))})
    context = plan.get("context", {})
    request = {
        "canvas": canvas,
        "context": {"goal": context.get("goal", "balanced"), "brief": context.get("brief", ""),
                    "focusConceptIds": [concept_aliases[item] for item in context.get("focusConceptIds", []) if item in concept_aliases]},
        "groups": [{"rootId": alias, "conceptIds": [concept_aliases.get(identifier, identifier) for identifier in group["conceptIds"]],
                    "route": "preserved" if preserved_group_text(group) is not None else "model",
                    "sourcePhrases": [item["promptText"] or item["label"] for item in group["concepts"]],
                    "supplement": group.get("text", ""), "priority": group["priority"], "requiredAnchors": group_anchors(group)}
                   for alias, group in aliases.items()],
    }
    return request, aliases


def parse_composition(raw: str, plan: dict[str, Any], aliases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    start = raw.find("{")
    try:
        parsed, _end = json.JSONDecoder().raw_decode(raw[start:]) if start >= 0 else (None, 0)
    except json.JSONDecodeError as error:
        raise ValueError("本机模型的画布整体描述JSON不完整。") from error
    if isinstance(parsed, dict) and set(parsed) == set(aliases) and all(isinstance(text, str) for text in parsed.values()):
        parsed = {"groups": [{"rootId": alias, "text": text} for alias, text in parsed.items()]}
    if not isinstance(parsed, dict) or not isinstance(parsed.get("groups"), list):
        raise ValueError("本机模型的画布整体描述格式无效。")
    seen = set()
    groups = []
    for row in parsed["groups"]:
        if not isinstance(row, dict) or not isinstance(row.get("rootId"), str):
            raise ValueError("本机模型的概念组编号无效。")
        alias = row["rootId"]
        if alias not in aliases or alias in seen:
            raise ValueError("本机模型改动或重复了概念组编号。")
        if not isinstance(row.get("text"), str):
            raise ValueError(f"概念组{alias}缺少text字符串，模型需要生成英文描述。")
        seen.add(alias)
        source = aliases[alias]
        groups.append({"rootId": source["rootId"], "conceptIds": list(source["conceptIds"]), "text": row.get("text"),
                       "origin": row.get("origin", "model")})
    if seen != set(aliases):
        raise ValueError("本机模型遗漏了概念组。")
    realization = validate_realization({"version": 1, "sourceFingerprint": plan_fingerprint(plan),
                                        "model": MODEL_NAME, "groups": groups}, plan)
    return validate_plan({**plan, "promptRealization": realization})


def save_composition_audit(audit: dict[str, Any]) -> str:
    directory = Path(__file__).resolve().parent / "outputs" / "compositions"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"COMPOSE-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:12]}.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return str(path)


def compose_plan(value: Any) -> dict[str, Any]:
    """Realize each root group with the full canvas supplied to local Qwen.

    This is constrained inference with the existing model, without fine-tuning.
    One model is loaded for the request. Each group allows one repair attempt.
    """
    global MODEL_STATE, MODEL_ERROR
    plan = validate_plan(value)
    request, aliases = composition_request(plan)
    model_groups = [group for group in aliases.values() if preserved_group_text(group) is None]
    if model_groups and not language_status()["available"]:
        raise FileNotFoundError("本地Qwen语言模型未安装，请配置XIUVEN_LANGUAGE_MODEL指向完整的本地模型目录。")
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    system = (
        "你是视觉设计英文编辑器。完整画布帮助理解主体与属性的关系，你只需要描述用户指定的当前组。"
        "将当前组的短语合为一个简洁英文短句。严格保留主体、颜色、数量、形状、所属关系和限制。"
        "其他组只是上下文，不能添加到当前组。单独的风格、构图、技法、颜色或背景只描述该项。"
        "中文翻译成英文，已经通顺的短语可保留。禁止补写物体、文化历史或设计评价。"
        "只输出当前组的英文描述，最多25个英文词，不输出JSON、编号、Markdown或解释。"
    )
    started = time.monotonic()
    model = tokenizer = inputs = output = None
    raw_responses = []
    completions = []
    realized_groups = []
    group_attempts = {}
    try:
        MODEL_STATE = "loading"
        MODEL_ERROR = None
        if model_groups:
            tokenizer = AutoTokenizer.from_pretrained(str(MODEL_PATH), local_files_only=True)
            use_cuda = torch.cuda.is_available()
            model = AutoModelForCausalLM.from_pretrained(
                str(MODEL_PATH), local_files_only=True,
                torch_dtype=torch.float16 if use_cuda else torch.float32,
                low_cpu_mem_usage=True, attn_implementation="sdpa",
            ).to("cuda" if use_cuda else "cpu")
            model.eval()
        MODEL_STATE = "running"
        canvas_anchor_names = {anchor["name"] for item in aliases.values() for anchor in group_anchors(item)}
        for alias, group in aliases.items():
            preserved = preserved_group_text(group)
            if preserved is not None:
                realized_groups.append({"rootId": alias, "text": preserved, "origin": "preserved"})
                group_attempts[alias] = 0
                completions.append({"rootId": group["rootId"], "alias": alias, "route": "preserved", "attempt": 0,
                                    "status": "preserved", "text": preserved})
                continue
            phrases = [item["promptText"] or item["label"] for item in group["concepts"]] or [group.get("text", "")]
            group_input = {"rootId": alias, "phrases": phrases, "priority": group["priority"], "required": group_anchors(group)}
            required = {anchor["name"] for anchor in group_input["required"]}
            forbidden = sorted(canvas_anchor_names - required)
            target = ("Write one English visual phrase for ONLY this group. Keep these exact English phrases and connect them grammatically; translate any Chinese:\n"
                      + "\n".join(f'"{phrase}"' for phrase in phrases)
                      + "\nRequired words: " + ", ".join(sorted(required))
                      + "\nThe following terms belong to OTHER groups and must not appear here: " + ", ".join(forbidden)
                      + "\nKeep all details of the requested group. Output only the English phrase.")
            messages = [{"role": "system", "content": system + "\n以下完整画布仅为背景上下文，具体输出范围以用户当前要求为准。\n"
                         + json.dumps(request, ensure_ascii=False)},
                        {"role": "user", "content": target}]
            for attempt in range(2):
                prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
                inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
                with torch.inference_mode():
                    output = model.generate(
                        **inputs, do_sample=False, max_new_tokens=180,
                        pad_token_id=tokenizer.eos_token_id, repetition_penalty=1.02,
                        temperature=1.0, top_p=1.0, top_k=50,
                    )
                raw = tokenizer.decode(output[0, inputs.input_ids.shape[1]:], skip_special_tokens=True)
                raw_responses.append(raw)
                group_attempts[alias] = attempt + 1
                completion = {"rootId": group["rootId"], "alias": alias, "route": "model", "attempt": attempt + 1,
                              "messages": list(messages), "raw_response": raw}
                completions.append(completion)
                try:
                    candidate = raw.strip().strip('"')
                    if candidate.startswith(("{", "[", "```")):
                        raise ValueError("请输出当前组的英文短句，省略JSON或Markdown格式。")
                    text = validate_group_text(candidate, group)
                    realized_groups.append({"rootId": alias, "text": text, "origin": "model"})
                    completion["status"] = "accepted"
                    break
                except ValueError as error:
                    completion.update({"status": "rejected", "error": str(error)})
                    if attempt == 1:
                        raise ValueError(f"本机画布描述的{alias}组未通过校验。{error}") from error
                    messages = [messages[0], {"role": "user", "content": target
                                + f"\n校验要求 {error}。逐字保留当前组全部英文短语，只调整连接词。"}]
        composed = parse_composition(json.dumps({"groups": realized_groups}), plan, aliases)
        MODEL_STATE = "cold"
        audit = {"method": COMPOSITION_METHOD, "status": "complete", "model": MODEL_NAME,
                 "sourcePlan": plan, "input": request, "attempts": len(raw_responses), "raw_responses": raw_responses,
                 "group_attempts": group_attempts, "completions": completions,
                 "elapsed_seconds": round(time.monotonic() - started, 2), "realization": composed["promptRealization"]}
        audit_path = save_composition_audit(audit)
        return {
            "semantic_plan": composed, "model": MODEL_NAME,
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "warnings": [f"已原样保留{len(aliases) - len(model_groups)}组独立英文条件，另外{len(model_groups)}组结合完整画布上下文调用本机模型整理，请核对后采纳。",
                         "数量、部分主体及色彩已做词汇检查，细微语义和文化准确性仍需人工确认。",
                         "使用现有Qwen本机推理，未复现论文中未公开的领域微调权重。"],
            "composition_audit": {**audit, "path": audit_path},
        }
    except Exception as error:
        MODEL_STATE = "error"
        MODEL_ERROR = str(error)
        audit_path = save_composition_audit({"method": COMPOSITION_METHOD, "status": "failed", "model": MODEL_NAME,
            "sourcePlan": plan, "input": request, "attempts": len(raw_responses), "raw_responses": raw_responses,
            "group_attempts": group_attempts, "completions": completions,
            "elapsed_seconds": round(time.monotonic() - started, 2), "error": str(error)})
        raise ValueError(f"{error} 诊断记录已保存至 {audit_path}") from error
    finally:
        del output, inputs, model, tokenizer
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

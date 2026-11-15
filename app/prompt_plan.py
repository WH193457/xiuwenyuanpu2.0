"""Validate and compile the editable semantic plan without loading an image model."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any
from semantic_checks import inspect_plan

COMPILER_VERSION = "dong-semantic-plan-6"
DIMENSIONS = ("subject", "composition", "palette", "intention", "style", "technique")
EVIDENCE_LEVELS = ("visual", "supported", "cautious", "neutral", "user")
FIXED_PREFIX = "dongzu"
ANNOTATION_FIELDS = ("main_elements", "secondary_elements", "composition", "symmetry_repeat", "colors", "meaning", "generation_keywords")
GOALS = ("balanced", "heritage", "minimal", "repeat")
ALGORITHMS = ("context-walk-v1", "context-walk-v2", "restart-v1")


def bounded_text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{field}需要是长度不超过{limit}的文本。")
    return " ".join(value.split())


def normalize_english(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).translate(str.maketrans({
        "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "、": ",", "。": ".",
    }))
    return " ".join(normalized.split())


def text_list(value: Any, field: str, maximum: int = 100) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f"{field}需要是最多{maximum}项的文本列表。")
    return list(dict.fromkeys(bounded_text(item, field, 256) for item in value))


def validate_provenance(concept: dict[str, Any], item: dict[str, Any]) -> None:
    if "annotations" in concept:
        annotations = concept["annotations"]
        if not isinstance(annotations, list) or len(annotations) > 160:
            raise ValueError("概念原始标注记录最多160条。")
        item["annotations"] = []
        for row in annotations:
            if not isinstance(row, dict) or row.get("field") not in ANNOTATION_FIELDS or row.get("evidence") not in EVIDENCE_LEVELS:
                raise ValueError("概念原始标注字段无效。")
            item["annotations"].append({
                "patternId": bounded_text(row.get("patternId"), "标注母纹", 256),
                "field": row["field"], "value": bounded_text(row.get("value"), "标注原文", 512),
                "sourceIds": text_list(row.get("sourceIds", []), "标注来源"), "evidence": row["evidence"],
            })
    if "recommendation" in concept:
        trace = concept["recommendation"]
        if not isinstance(trace, dict) or trace.get("algorithm") not in ALGORITHMS or trace.get("goal") not in GOALS:
            raise ValueError("推荐来源记录无效。")
        nodes = text_list(trace.get("nodes"), "推荐路径", 7)
        relations = trace.get("relations")
        if not isinstance(relations, list) or len(relations) != max(0, len(nodes) - 1):
            raise ValueError("推荐路径与关系数量不一致。")
        normalized = [text_list(row, "推荐关系", 7) for row in relations]
        if any(not row or any(field not in ANNOTATION_FIELDS for field in row) for row in normalized):
            raise ValueError("推荐关系类型无效。")
        item["recommendation"] = {"algorithm": trace["algorithm"], "goal": trace["goal"], "nodes": nodes,
            "relations": normalized, "sourceIds": text_list(trace.get("sourceIds", []), "推荐来源"),
            "factors": text_list(trace.get("factors", []), "推荐因素", 8)}


def validate_plan(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("语义方案版本无效，目前支持version 1。")
    concepts = value.get("concepts")
    if not isinstance(concepts, list) or len(concepts) > 48:
        raise ValueError("语义方案需要包含最多48个概念。")
    normalized = []
    seen = set()
    for concept in concepts:
        if not isinstance(concept, dict):
            raise ValueError("每个语义概念需要是对象。")
        identifier = bounded_text(concept.get("id"), "概念编号", 256)
        if not identifier or identifier in seen:
            raise ValueError("概念编号需要非空且唯一。")
        seen.add(identifier)
        dimension = concept.get("dimension")
        evidence = concept.get("evidence")
        priority = concept.get("priority")
        if dimension not in DIMENSIONS or evidence not in EVIDENCE_LEVELS:
            raise ValueError("概念维度或证据类别无效。")
        if type(priority) is not int or priority not in (1, 2, 3):
            raise ValueError("概念优先级需要为1、2或3。")
        if type(concept.get("enabled")) is not bool:
            raise ValueError("概念启用状态需要为布尔值。")
        label = bounded_text(concept.get("label"), "概念名称", 512)
        if not label:
            raise ValueError("概念名称需要非空。")
        item = {
            "id": identifier, "dimension": dimension, "label": label,
            "promptText": bounded_text(concept.get("promptText", ""), "英文条件", 512),
            "priority": priority, "enabled": concept["enabled"],
            "patternIds": text_list(concept.get("patternIds", []), "母纹来源"),
            "sourceIds": text_list(concept.get("sourceIds", []), "资料来源"),
            "evidence": evidence,
        }
        parent_id = concept.get("parentId")
        if parent_id is not None:
            item["parentId"] = bounded_text(parent_id, "所属主体", 256)
            if not item["parentId"]:
                raise ValueError("所属主体编号需要非空。")
        validate_provenance(concept, item)
        normalized.append(item)
    by_id = {item["id"]: item for item in normalized}
    for item in normalized:
        path = {item["id"]}
        current = item
        while current.get("parentId"):
            parent = by_id.get(current["parentId"])
            if parent is None or parent["dimension"] != "subject":
                raise ValueError("所属主体必须引用画布中存在的主体概念。")
            if parent["id"] in path:
                raise ValueError("概念所属关系不能形成循环。")
            path.add(parent["id"])
            current = parent
    result = {"version": 1, "concepts": normalized, "extraPrompt": bounded_text(value.get("extraPrompt", ""), "补充描述", 1000)}
    if "extraPromptTranslation" in value:
        translation = value["extraPromptTranslation"]
        if not isinstance(translation, dict):
            raise ValueError("补充描述译文记录无效。")
        source = bounded_text(translation.get("sourceText"), "补充描述原文", 1000)
        text = normalize_english(bounded_text(translation.get("text"), "补充描述译文", 1000))
        model = bounded_text(translation.get("model"), "翻译模型", 256)
        if not model or not english_clause(text):
            raise ValueError("补充描述的译文或模型记录无效。")
        # Editing the original invalidates old translations, including in restored drafts.
        if source == result["extraPrompt"]:
            result["extraPromptTranslation"] = {"sourceText": source, "text": text, "model": model}
    if "context" in value:
        context = value["context"]
        if not isinstance(context, dict) or context.get("goal") not in GOALS or context.get("algorithm") not in ALGORITHMS:
            raise ValueError("创作目标或推荐算法无效。")
        result["context"] = {"goal": context["goal"], "algorithm": context["algorithm"],
            "brief": bounded_text(context.get("brief", ""), "创作意图", 600),
            "focusConceptIds": text_list(context.get("focusConceptIds", []), "反馈重点", 256),
            "excludedConceptIds": text_list(context.get("excludedConceptIds", []), "暂不推荐", 256)}
    realization = value.get("promptRealization")
    if realization is not None:
        if not isinstance(realization, dict):
            raise ValueError("画布整体描述记录无效。")
        # A semantic edit invalidates the approved prose. Provenance-only changes
        # and the automatic supplement translation do not change its input.
        if realization.get("sourceFingerprint") == plan_fingerprint(result):
            result["promptRealization"] = validate_realization(realization, result)
    return result


def english_clause(value: str) -> bool:
    return bool(re.search(r"[A-Za-z]", value)) and all(32 <= ord(char) <= 126 for char in value)


def token_count(tokenizer: Any, prompt: str) -> int:
    return len(tokenizer(prompt, add_special_tokens=True, truncation=False)["input_ids"])


def plan_fingerprint(plan: dict[str, Any]) -> str:
    fields = ("id", "dimension", "label", "promptText", "priority", "enabled", "parentId")
    context = plan.get("context", {})
    semantic_input = {
        "concepts": [{key: item.get(key) for key in fields} for item in plan["concepts"]],
        "extraPrompt": plan["extraPrompt"],
        "context": {"goal": context.get("goal", "balanced"), "brief": context.get("brief", ""),
                    "focusConceptIds": context.get("focusConceptIds", [])},
    }
    encoded = json.dumps(semantic_input, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def realization_groups(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Partition the active canvas by root, including all active descendants."""
    children: dict[str, list[dict[str, Any]]] = {}
    for item in plan["concepts"]:
        if item.get("parentId"):
            children.setdefault(item["parentId"], []).append(item)

    def collect(item: dict[str, Any]) -> list[dict[str, Any]]:
        if not item["enabled"]:
            return []
        return [item, *[descendant for child in children.get(item["id"], []) for descendant in collect(child)]]

    groups = []
    for root in plan["concepts"]:
        if root.get("parentId"):
            continue
        members = collect(root)
        if members:
            groups.append({"rootId": root["id"], "conceptIds": [item["id"] for item in members],
                           "concepts": members, "priority": max(item["priority"] for item in members)})
    if plan["extraPrompt"]:
        groups.append({"rootId": "extraPrompt", "conceptIds": ["extraPrompt"], "concepts": [],
                       "priority": 0, "text": plan["extraPrompt"]})
    return groups


# These checks catch concrete losses and substitutions, while human acceptance
# remains necessary for semantics outside this explicitly bounded vocabulary.
ANCHOR_TERMS = {
    "butterfly": ("butterfly", "butterflies", "蝴蝶"),
    "bird": ("bird", "birds", "鸟"), "fish": ("fish", "fishes", "鱼"),
    "dragon": ("dragon", "dragons", "龙"), "phoenix": ("phoenix", "phoenixes", "凤凰"),
    "flower": ("flower", "flowers", "floral", "花"),
    "leaf": ("leaf", "leaves", "叶"), "lotus": ("lotus", "莲"),
    "star": ("star", "stars", "星"), "diamond": ("diamond", "diamonds", "菱形"),
    "circle": ("circle", "circles", "circular", "圆形"),
    "wing": ("wing", "wings", "翅"), "horse": ("horse", "horses", "马"),
    "human": ("human", "humans", "person", "people", "人形", "人物"),
    "symmetry": ("symmetry", "symmetric", "symmetrical", "对称", "镜像"),
    "embroidery": ("embroidery", "embroidered", "embroidering", "刺绣", "侗绣"),
    "stitch": ("stitch", "stitches", "stitching", "针脚"),
    "background": ("background", "backgrounds", "背景"),
    "red": ("red", "vermilion", "红"), "blue": ("blue", "indigo", "蓝"),
    "green": ("green", "绿"), "yellow": ("yellow", "黄"),
    "black": ("black", "黑"), "white": ("white", "ivory", "白"),
    "ivory": ("ivory", "off-white", "off white", "cream", "米白", "乳白"),
    "silver": ("silver", "银"), "gold": ("gold", "golden", "金色"),
    "purple": ("purple", "violet", "紫"), "pink": ("pink", "粉色"),
    "orange": ("orange", "橙"), "brown": ("brown", "棕", "褐"),
    "indigo": ("indigo", "靛蓝"), "vermilion": ("vermilion", "朱红"),
}
NUMBER_WORDS = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve")


def contains_anchor(text: str, alternatives: tuple[str, ...]) -> bool:
    return any(re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", text, flags=re.IGNORECASE)
               if term.isascii() else term in text for term in alternatives)


def group_anchors(group: dict[str, Any]) -> list[dict[str, Any]]:
    source = " ".join([group.get("text", ""), *[item["label"] + " " + item["promptText"] for item in group["concepts"]]])
    anchors = [{"name": name, "alternatives": [word for word in alternatives if word.isascii()]}
               for name, alternatives in ANCHOR_TERMS.items() if contains_anchor(source, alternatives)]
    for number, word in enumerate(NUMBER_WORDS):
        alternatives = (str(number), word, "paired", "pair") if number == 2 else (str(number), word)
        if contains_anchor(source, alternatives):
            anchors.append({"name": f"number:{number}", "alternatives": list(alternatives)})
    chinese_numbers = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6,
                       "七": 7, "八": 8, "九": 9, "十": 10}
    for token in re.findall(r"(?<![一二两三四五六七八九十])([一二两三四五六七八九十])(?:只|个|朵|片|条|枚|组|对)", source):
        number = chinese_numbers[token]
        anchor = {"name": f"number:{number}", "alternatives": [str(number), NUMBER_WORDS[number]]}
        if anchor["name"] not in {item["name"] for item in anchors}:
            anchors.append(anchor)
    for number in re.findall(r"(?<![a-z0-9])\d+(?:\.\d+)?(?![a-z0-9])", source, flags=re.IGNORECASE):
        if number not in {str(index) for index in range(len(NUMBER_WORDS))}:
            anchors.append({"name": f"number:{number}", "alternatives": [number]})
    return anchors


def validate_group_text(value: Any, group: dict[str, Any]) -> str:
    text = normalize_english(bounded_text(value, "整体英文描述", 512))
    if not english_clause(text):
        raise ValueError("画布整体描述需要可用的英文文本。")
    anchors = group_anchors(group)
    missing = [anchor["name"] for anchor in anchors if not contains_anchor(text, tuple(anchor["alternatives"]))]
    if missing:
        raise ValueError(f"画布整体描述遗漏了主体、色彩或数量条件（{', '.join(missing)}），请重试或精简画布。")
    allowed = {anchor["name"] for anchor in anchors}
    added = [name for name, alternatives in ANCHOR_TERMS.items()
             if name not in allowed and contains_anchor(text, tuple(word for word in alternatives if word.isascii()))]
    if added:
        raise ValueError(f"概念组{group['rootId']}引入了该组没有的主体或色彩（{', '.join(added)}），请保持属性所属范围。")
    return text


def preserved_group_text(group: dict[str, Any]) -> str | None:
    """Keep an already-English non-subject atomic condition unchanged."""
    if len(group["concepts"]) != 1 or group["concepts"][0]["dimension"] == "subject":
        return None
    text = normalize_english(group["concepts"][0]["promptText"])
    return text if english_clause(text) else None


def validate_realization(value: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    if type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("画布整体描述版本无效。")
    model = bounded_text(value.get("model"), "画布描述模型", 256)
    if not model:
        raise ValueError("画布整体描述需要记录模型。")
    expected = realization_groups(plan)
    rows = value.get("groups")
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise ValueError("画布整体描述遗漏或增加了概念组。")
    by_root = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("rootId"), str) or row["rootId"] in by_root:
            raise ValueError("画布整体描述的概念组编号无效或重复。")
        by_root[row["rootId"]] = row
    normalized = []
    for group in expected:
        row = by_root.get(group["rootId"])
        if row is None or row.get("conceptIds") != group["conceptIds"]:
            raise ValueError("画布整体描述改动了概念组或所属关系。")
        origin = row.get("origin", "model")
        if origin not in {"model", "preserved"}:
            raise ValueError("画布整体描述的文本来源无效。")
        if origin == "preserved":
            text = normalize_english(bounded_text(row.get("text"), "保留的原子条件", 512))
            if text != preserved_group_text(group):
                raise ValueError("保留的原子条件必须与该组原英文一致，且只适用于非主体的独立英文概念。")
        else:
            text = validate_group_text(row.get("text"), group)
        normalized.append({"rootId": group["rootId"], "conceptIds": list(group["conceptIds"]), "text": text, "origin": origin})
    return {"version": 1, "sourceFingerprint": plan_fingerprint(plan), "model": model, "groups": normalized}


def compile_plan(value: Any, tokenizer: Any = None, *, subject_first: bool = False) -> dict[str, Any]:
    plan = validate_plan(value)
    warnings: list[str] = []
    dispositions: dict[str, dict[str, str]] = {}
    children: dict[str, list[dict[str, Any]]] = {}
    roots = []
    by_id = {item["id"]: item for item in plan["concepts"]}
    for concept in plan["concepts"]:
        parent_id = concept.get("parentId")
        if parent_id:
            children.setdefault(parent_id, []).append(concept)
        else:
            roots.append(concept)

    def omit(concept: dict[str, Any], reason: str) -> None:
        if concept["enabled"]:
            dispositions[concept["id"]] = {"id": concept["id"], "status": "omitted", "reason": reason}

    def group(concept: dict[str, Any], ancestor_reason: str = "") -> tuple[str, list[str], int]:
        reason = ancestor_reason
        text = normalize_english(concept["promptText"])
        if not reason and not concept["enabled"]:
            reason = f"所属主体“{concept['label']}”已停用"
        if not reason and not english_clause(text):
            reason = f"“{concept['label']}”缺少可用英文描述"
            warnings.append(f"{reason}，可使用中文描述整理功能。")
        if reason:
            omit(concept, reason)
            for child in children.get(concept["id"], []):
                group(child, reason)
            return "", [], 0
        identifiers = [concept["id"]]
        priority = concept["priority"]
        attributes = []
        for child in children.get(concept["id"], []):
            child_text, child_ids, child_priority = group(child)
            if child_text:
                attributes.append(child_text)
                identifiers.extend(child_ids)
                priority = max(priority, child_priority)
        clause = text + (" with " + " and ".join(attributes) if attributes else "")
        return clause, identifiers, priority

    realization = plan.get("promptRealization")
    if realization:
        active_groups = realization_groups(plan)
        realized_texts = {item["rootId"]: item["text"] for item in realization["groups"]}
        groups = [(realized_texts[item["rootId"]], item["conceptIds"], item["priority"]) for item in active_groups]
        active_ids = {identifier for item in active_groups for identifier in item["conceptIds"]}
        for concept in plan["concepts"]:
            if concept["enabled"] and concept["id"] not in active_ids:
                omit(concept, "所属主体已停用")
        warnings.append("已采用经确认的本机模型整体描述；词汇检查覆盖有限，主体关系与文化意向仍需人工核对。")
    else:
        groups = [group(concept) for concept in roots]
    # In subject-first mode, keep each accepted subject/attribute group intact.
    # These categories control budget order, not CLIP attention weights.
    def group_order(item):
        dimensions = {by_id[identifier]["dimension"] for identifier in item[1] if identifier in by_id}
        category = 0 if "subject" in dimensions else 1 if "composition" in dimensions else 2
        return (category if subject_first else 0, -item[2])

    groups.sort(key=group_order)
    if plan["extraPrompt"] and not realization:
        extra = normalize_english(plan["extraPrompt"])
        if not english_clause(extra) and plan.get("extraPromptTranslation"):
            extra = plan["extraPromptTranslation"]["text"]
        if english_clause(extra):
            groups.append((extra, ["extraPrompt"], 0))
        else:
            dispositions["extraPrompt"] = {"id": "extraPrompt", "status": "omitted", "reason": "补充描述缺少可用英文条件"}
            warnings.append("补充描述尚未完成翻译，请通过本机服务预览或生成，服务会自动整理中文与中英混合描述。")

    prefix = "" if subject_first else FIXED_PREFIX
    parts = [prefix] if prefix else []
    seen = {prefix.casefold()} if prefix else set()
    limit = min(int(tokenizer.model_max_length), 77) if tokenizer is not None else None
    for text, identifiers, _priority in groups:
        if not text:
            continue
        reason = ""
        if text.casefold() in seen:
            reason = "与已采用的完整描述重复"
        elif tokenizer is not None and token_count(tokenizer, ", ".join([*parts, text])) > limit:
            reason = "所属概念组超出CLIP词元预算"
            labels = [by_id[identifier]["label"] for identifier in identifiers if identifier in by_id]
            warnings.append(f"“{'、'.join(labels) or '补充描述'}”超出CLIP词元预算，整组省略，可提高优先级或缩短描述。")
        status = "omitted" if reason else "applied"
        for identifier in identifiers:
            dispositions[identifier] = {"id": identifier, "status": status, "reason": reason or "已编入提示词"}
        if not reason:
            parts.append(text)
            seen.add(text.casefold())
    ordered = [dispositions[item["id"]] for item in plan["concepts"] if item["enabled"]]
    if "extraPrompt" in dispositions:
        ordered.append(dispositions["extraPrompt"])
    applied_ids = [item["id"] for item in dispositions.values() if item["status"] == "applied"]
    omitted_ids = [item["id"] for item in ordered if item["status"] == "omitted"]
    if subject_first:
        lost_subjects = [item for item in roots if item["enabled"] and item["dimension"] == "subject"
                         and item["id"] not in applied_ids]
        if lost_subjects:
            reasons = "；".join(f"{item['label']}（{dispositions[item['id']]['reason']}）" for item in lost_subjects)
            raise ValueError(f"主体条件未能完整编入提示词，请缩短或补充主体描述后重试。{reasons}")
    if not applied_ids:
        if subject_first:
            raise ValueError("主体与构图优先模式需要至少一项可用英文条件，请补充主体或描述后重试。")
        warnings.append("当前方案没有可用创作条件，生成将仅使用LoRA触发词dongzu。")
    if tokenizer is None:
        warnings.append("本地分词器尚不可用，生成时将按CLIP词元预算重新检查完整条件。")
    prompt = ", ".join(parts)
    checks = inspect_plan(plan)
    checks.extend({"code": "omitted-condition", "severity": "warning", "conceptIds": [item["id"]],
        "message": item["reason"]} for item in ordered if item["status"] == "omitted")
    warnings.extend(check["message"] for check in checks if check["severity"] == "warning" and check["code"] != "omitted-condition")
    return {
        "prompt": prompt, "semantic_plan": plan, "compiler_version": COMPILER_VERSION,
        "fixed_prompt_prefix": prefix, "applied_concept_ids": applied_ids,
        "omitted_concept_ids": omitted_ids, "concept_dispositions": ordered,
        "prompt_token_count": token_count(tokenizer, prompt) if tokenizer is not None else None,
        "token_limit": limit, "warnings": warnings, "plan_checks": checks,
    }

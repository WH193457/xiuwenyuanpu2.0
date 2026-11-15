"""Versioned, explicit text conditioning for the local subject-first profile."""

import re

from prompt_plan import token_count

PROFILES = ("standard", "subject-fidelity")
POLICY_VERSION = "subject-fidelity-1"


def generation_profile(payload):
    profile = payload.get("generation_profile", "standard")
    if profile not in PROFILES:
        raise ValueError("generation_profile需要为standard或subject-fidelity。")
    if profile == "subject-fidelity" and "semantic_plan" not in payload:
        raise ValueError("主体与构图优先模式需要提供semantic_plan。")
    return profile


def positive_text(text):
    """Retain the positive prefix before a negation and its coordinated list."""
    text = re.sub(r"\bnon[- ](?:repeating|repeated|tiled|tiling)\b", "", text.lower())
    clauses = re.split(r"[,.;]|\bbut\b|\band\s+(?=(?:add|keep|show|use|repeat|preserve)\b)", text)
    return " ".join(re.split(r"\b(?:no|not|without|avoid|exclude|remove)\b", clause, maxsplit=1)[0]
                    for clause in clauses)


def fidelity_conditioning(compiled, tokenizer):
    """Use only conditions that actually survived compilation.

    Explicit positive border/repeat requests take precedence over suppression.
    Child-only spatial conditions do not establish the global layout. The checks
    are conservative English phrase rules, and their decisions are persisted.
    """
    plan = compiled["semantic_plan"]
    applied = set(compiled["applied_concept_ids"])
    concepts = [item for item in plan["concepts"] if item["id"] in applied]
    positive = positive_text(compiled["prompt"])
    realized = {group["rootId"]: group for group in plan.get("promptRealization", {}).get("groups", [])}
    global_texts = []
    for item in concepts:
        if item.get("parentId") or item["dimension"] not in ("composition", "subject"):
            continue
        group = realized.get(item["id"])
        # A merged subject group can contain local spatial attributes. Use its
        # original root text to avoid promoting those attributes to global ones.
        global_texts.append(group["text"] if group and len(group["conceptIds"]) == 1 else item["promptText"])
    if "extraPrompt" in applied:
        global_texts.append(realized.get("extraPrompt", {}).get("text",
                            plan.get("extraPromptTranslation", {}).get("text", plan["extraPrompt"])))
    positive_global = positive_text(", ".join(global_texts))

    frame_requested = bool(re.search(r"\b(?:frames?|framed|hoops?)\b", positive))
    border_requested = frame_requested or bool(re.search(r"\b(?:borders?|edging)\b", positive))
    repeat_requested = bool(re.search(r"\b(?:repeats?|repeating|repeated|tiled|tiling|seamless|all.over|bands?|rows?|arrays?|tessellation)\b", positive))
    horizontal = bool(re.search(r"\bhorizontal\b", positive_global))
    vertical = bool(re.search(r"\bvertical\b", positive_global))
    focused = bool(re.search(r"\b(?:centered|centred|isolated|single|radial)\b", positive_global))
    panel_requested = bool(re.search(r"\b(?:panels?|segmented|sections?|grid)\b", positive))

    terms = []
    if not frame_requested:
        terms.extend(["embroidery hoop", "circular frame", "picture frame", "decorative frame"])
    if not border_requested:
        terms.append("ornamental border")
    for term in ("carpet", "rug", "tapestry"):
        if not re.search(r"\b" + term + r"s?\b", positive):
            terms.append(term)
    terms.extend(["watermark", "text", "blurry", "low quality"])
    if not re.search(r"\b(?:photo|photograph|photographic|photorealistic)\b", positive):
        terms.append("photograph")
    if not re.search(r"\b(?:cropped|close.up|macro)\b", positive):
        terms.extend(["cropped", "cut off"])
    if horizontal and not vertical and not re.search(r"\bvertical\s+stripes?\b", positive):
        terms.append("vertical stripes")
    if focused and not repeat_requested:
        terms.extend(["tiled", "repeating pattern"])
    if not panel_requested:
        terms.append("multiple panels")

    limit = min(int(tokenizer.model_max_length), 77) if tokenizer is not None else None
    accepted, omitted = [], []
    for term in terms:
        if tokenizer is not None and token_count(tokenizer, ", ".join([*accepted, term])) > limit:
            omitted.append(term)
        else:
            accepted.append(term)
    negative = ", ".join(accepted)
    return negative, {
        "version": POLICY_VERSION,
        "subject_first": True,
        "trigger_word": "",
        "border_requested": border_requested,
        "frame_requested": frame_requested,
        "repeat_requested": repeat_requested,
        "layout": "horizontal-band" if horizontal and repeat_requested and not vertical else "focused" if focused and not repeat_requested else "free",
        "negative_terms": accepted,
        "omitted_negative_terms": omitted,
        "negative_token_count": token_count(tokenizer, negative) if tokenizer is not None else None,
        "spatial_control": "text-only",
    }

"""Conservative, scope-aware checks. These diagnose conditions, not cultural truth."""

import re


def active_concepts(plan):
    by_id = {item["id"]: item for item in plan["concepts"]}
    result = []
    for item in plan["concepts"]:
        current, seen = item, set()
        while current and current["enabled"] and current["id"] not in seen:
            seen.add(current["id"])
            if not current.get("parentId"):
                result.append(item)
                break
            current = by_id.get(current["parentId"])
    return result


def inspect_plan(plan):
    active = active_concepts(plan)
    checks = []

    def add(code, ids, message, severity="warning"):
        checks.append({"code": code, "severity": severity, "conceptIds": ids, "message": message})

    for item in active:
        if item["dimension"] == "intention":
            if item["evidence"] != "supported":
                add("interpretation-needs-review", [item["id"]],
                    f"“{item['label']}”仅作为设计意向；其文化含义仍需人工核实。", "info")
            elif not item["sourceIds"]:
                add("missing-cultural-source", [item["id"]], f"“{item['label']}”标为资料支持，但缺少来源编号。")
    scopes = {}
    for item in active:
        if item["dimension"] == "composition":
            scopes.setdefault(item.get("parentId", "global"), []).append(item)
    conflicts = [
        (r"单体式|isolated single motif", r"满铺式|all-over repeating pattern", "独立单体与满铺重复"),
        (r"左右对称|bilateral symmetry", r"非严格对称|loose asymmetry", "左右对称与非严格对称"),
    ]
    for items in scopes.values():
        for left, right, label in conflicts:
            matching = [[item["id"] for item in items if re.search(expression, item["label"] + " " + item["promptText"], re.I)] for expression in (left, right)]
            if all(matching):
                add("composition-conflict", list(dict.fromkeys(matching[0] + matching[1])),
                    f"同一作用范围包含{label}，建议停用其中一项或分别关联到不同主体。")
    subjects = [item for item in active if item["dimension"] == "subject" and not item.get("parentId")]
    colors = [item for item in active if item["dimension"] == "palette" and not item.get("parentId")]
    if len(subjects) > 1 and colors:
        add("global-palette", [item["id"] for item in colors], "当前有多个主体，共用全局配色；若要分别配色，请将颜色关联到对应主体。", "info")
    return checks

"""Small CPU diagnostics on generated pixels, never a cultural/semantic score.

RGB MAE after resizing to 128x128: score = 1 - MAE/255. Flat images are marked
unreliable. Only global, actually compiled composition requests are measured;
subject-local requirements need masks and are deliberately not scored here.
"""
from semantic_checks import active_concepts


def structure_metrics(image, plan, applied_ids):
    if not plan:
        return []
    requests = {}
    for item in active_concepts(plan):
        if item["id"] not in applied_ids or item["dimension"] != "composition" or item.get("parentId"):
            continue
        text = (item["label"] + " " + item["promptText"]).lower()
        if "左右对称" in text or "bilateral symmetry" in text:
            requests.setdefault("mirror_lr", []).append(item["id"])
        # Arbitrary rotational symmetry does not imply 180 degrees (e.g. 3-fold).
        if "180" in text and ("旋转" in text or "rotat" in text):
            requests.setdefault("rotate_180", []).append(item["id"])
        if "满铺式" in text or "all-over repeating pattern" in text or "seamless" in text:
            requests.setdefault("tile_edges", []).append(item["id"])
    if not requests:
        return []
    from PIL import Image, ImageChops, ImageOps, ImageStat
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    rgb = Image.alpha_composite(background, rgba).convert("RGB").resize((128, 128), Image.Resampling.LANCZOS)
    reliable = max(ImageStat.Stat(rgb).stddev) >= 8
    result = []
    for kind, identifiers in requests.items():
        if kind == "mirror_lr":
            difference = ImageChops.difference(rgb, ImageOps.mirror(rgb))
            label = "左右镜像像素相似度"
        elif kind == "rotate_180":
            difference = ImageChops.difference(rgb, rgb.transpose(Image.Transpose.ROTATE_180))
            label = "180°旋转像素相似度"
        else:
            horizontal = ImageChops.difference(rgb.crop((0, 0, 1, 128)), rgb.crop((127, 0, 128, 128)))
            vertical = ImageChops.difference(rgb.crop((0, 0, 128, 1)), rgb.crop((0, 127, 128, 128))).transpose(Image.Transpose.ROTATE_90)
            difference = Image.new("RGB", (2, 128))
            difference.paste(horizontal, (0, 0))
            difference.paste(vertical, (1, 0))
            label = "上下左右接缝像素相似度"
        score = round(max(0, min(1, 1 - sum(ImageStat.Stat(difference).mean) / (3 * 255))), 4)
        result.append({"kind": kind, "label": label, "score": score, "conceptIds": identifiers,
            "reliable": reliable, "note": "仅比较全图像素，不能判断主体、文化含义或局部结构是否正确。" if reliable
            else "图像变化较少或接近纯色，此分数不宜用于判断结构保持效果。"})
    return result

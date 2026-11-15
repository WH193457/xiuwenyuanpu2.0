"""Fixed-seed engineering exploration of reference-based local generation."""
import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("HF_HOME", str(ROOT.parent / "lora-scripts-main/huggingface"))
os.environ.setdefault("XFORMERS_FORCE_DISABLE_TRITON", "1")
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
import lora_service as service
from reference_conditioning import prepare_reference, load_reference_conditioning
from PIL import Image, ImageDraw

OUT = ROOT / "outputs/reference-control-exploration-2026-11-09"
CASES = [
    {"id": "butterfly", "pattern_id": "DX027", "mask_mode": "dark", "threshold": 190,
     "foreground_color": "#D12D3E", "background_color": "#25549A", "layout": "centered",
     "prompt": "a single red butterfly, centered composition, complete paired wings and antennae, blue fabric background", "seed": 110101},
    {"id": "star", "pattern_id": "DX013", "mask_mode": "light", "threshold": 245,
     "foreground_color": "#F5F0E6", "background_color": "#25549A", "layout": "centered",
     "prompt": "a single white eight-pointed star, centered radial composition, blue fabric background", "seed": 440401},
    {"id": "people", "pattern_id": "DX017", "mask_mode": "dark", "threshold": 140, "crop": [0, .04, 1, .73],
     "foreground_color": "#17191D", "background_color": "#F5F0E6", "layout": "horizontal-band",
     "prompt": "three black human figures joining hands in one horizontal row, ivory fabric background", "seed": 880801},
    {"id": "zigzag", "pattern_id": "DX017", "mask_mode": "dark", "threshold": 140, "crop": [0, .80, 1, .98],
     "foreground_color": "#17191D", "background_color": "#F5F0E6", "layout": "horizontal-band",
     "prompt": "one black horizontal zigzag embroidery band, continuous repeating zigzag strip, ivory fabric background", "seed": 550501},
]
VARIANTS = [{"id": "img055", "method": "img2img", "strength": .55, "control_scale": 0},
            {"id": "cn055", "method": "canny-img2img", "strength": .55, "control_scale": 1.0},
            {"id": "cn070", "method": "canny-img2img", "strength": .70, "control_scale": 1.0}]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--texture-round", action="store_true")
    args = parser.parse_args()
    global OUT, VARIANTS
    if args.texture_round:
        OUT = ROOT / "outputs/reference-texture-exploration-2026-11-09"
        service.EMBROIDERY_PROMPT = "embroidered applique, dense parallel satin stitches, shiny silk threads, woven cotton, directional light"
        VARIANTS = [
            {"id": "cn080-l035", "method": "canny-img2img", "strength": .80, "control_scale": .7, "lora_scale": .35},
            {"id": "cn085-l035", "method": "canny-img2img", "strength": .85, "control_scale": .7, "lora_scale": .35},
            {"id": "cn085-l070", "method": "canny-img2img", "strength": .85, "control_scale": .7, "lora_scale": .70},
        ]
    OUT.mkdir(exist_ok=True)
    state_path = OUT / "records.json"
    records = json.loads(state_path.read_text("utf-8")) if state_path.exists() else []
    for case in CASES:
        reference_file = OUT / f"{case['id']}-reference.json"
        if reference_file.exists():
            prepared = json.loads(reference_file.read_text("utf-8"))
        else:
            prepared = prepare_reference({key: value for key, value in case.items() if key not in ("id", "prompt", "seed")} |
                                         {"palette_mode": "solid", "margin": .12, "width": 512, "height": 512})
            reference_file.write_text(json.dumps(prepared, ensure_ascii=False, indent=2), "utf-8")
        config = {"reference_id": prepared["reference_id"], "reference_sha256": prepared["reference_sha256"],
                  "method": "canny-img2img", "strength": .55, "control_scale": 1., "embroidery_detail": True}
        ref = load_reference_conditioning(config)
        for key, name in (("image", "init"), ("control_image", "control"), ("mask_image", "mask")):
            ref[key].save(OUT / f"{case['id']}-{name}.png")
        if args.prepare_only:
            continue
        plan = {"version": 1, "concepts": [{"id": "subject", "dimension": "subject", "label": case["id"],
            "promptText": case["prompt"], "priority": 3, "enabled": True, "patternIds": [case["pattern_id"]],
            "sourceIds": [], "evidence": "user"}], "extraPrompt": ""}
        for variant in VARIANTS:
            identifier = f"{case['id']}-{variant['id']}"
            if any(record["id"] == identifier for record in records):
                continue
            payload = {"semantic_plan": plan, "generation_profile": "subject-fidelity", "pattern_id": case["pattern_id"],
                "reference_conditioning": config | {key: value for key, value in variant.items() if key not in ("id", "lora_scale")},
                "seed": case["seed"], "count": 2, "lora_scale": variant.get("lora_scale", .35), "steps": 30, "guidance": 7.2, "width": 512, "height": 512}
            result = service.generate(payload)
            result.pop("image_data_url", None)
            for item in result["candidates"]:
                item.pop("image", None)
            records.append({"id": identifier, "payload": payload, "result": result})
            state_path.write_text(json.dumps(records, ensure_ascii=False, indent=2), "utf-8")
            print(identifier, result["inference_seconds"], flush=True)
        sheet = Image.new("RGB", (1200, 660), "white")
        draw = ImageDraw.Draw(sheet)
        for row in range(2):
            sheet.paste(ref["image"].resize((300, 300)), (0, row * 330 + 30))
            draw.text((5, row * 330 + 5), f"{case['id']} reference / seed {case['seed'] + row}", fill="black")
            for column, variant in enumerate(VARIANTS, 1):
                record = next(r for r in records if r["id"] == f"{case['id']}-{variant['id']}")
                draw.text((column * 300 + 5, row * 330 + 5), variant["id"], fill="black")
                sheet.paste(Image.open(record["result"]["candidates"][row]["path"]).resize((300, 300)), (column * 300, row * 330 + 30))
        sheet.save(OUT / f"{case['id']}-comparison.png")
    (OUT / "protocol.json").write_text(json.dumps({"type": "engineering exploration", "cases": CASES, "variants": VARIANTS,
        "count": 2, "default_lora_scale": .35, "texture_prompt": service.EMBROIDERY_PROMPT,
        "steps": 30, "guidance": 7.2, "width": 512, "height": 512,
        "reference_input": "explicit threshold mask, source crop and two-color preparation", "postprocessing": "none"},
        ensure_ascii=False, indent=2), "utf-8")


if __name__ == "__main__":
    main()

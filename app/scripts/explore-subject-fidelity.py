"""Retained, fixed-seed engineering exploration of local SD conditioning."""
import argparse
import json
import math
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("HF_HOME", str(ROOT.parent / "lora-scripts-main" / "huggingface"))
os.environ.setdefault("XFORMERS_FORCE_DISABLE_TRITON", "1")
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
import lora_service as service
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("--ablation", action="store_true")
args = parser.parse_args()
out = ROOT / "outputs" / ("subject-fidelity-ablation-2026-11-09" if args.ablation else "subject-fidelity-exploration-2026-11-09")
out.mkdir(exist_ok=True)
manifest = json.loads((ROOT / "outputs/reproduction-2026-11-09-v2/manifest.json").read_text("utf-8"))
tasks = [task for task in manifest["tasks"] if task["id"] in ("T01", "T05", "T06", "T07")]
variants = [
    {"id": "static035", "scale": .35, "delay": 0},
    {"id": "static015", "scale": .15, "delay": 0},
    {"id": "delayed035", "scale": .35, "delay": .45},
    {"id": "base", "scale": 0., "delay": 0},
]
if args.ablation:
    tasks = tasks[:3]
    variants = [
        {"id": "no-trigger-old-negative", "scale": .35, "delay": 0},
        {"id": "trigger-new-negative", "scale": .35, "delay": 0},
        {"id": "no-trigger-hoop-negative", "scale": .35, "delay": 0},
    ]
protocol = {"type": "engineering exploration, not independent confirmation", "tasks": [t["id"] for t in tasks],
            "seeds": "first two original seeds per task", "variants": variants, "steps": 30, "guidance": 7.2,
            "conditioning": ("trigger and negative-prompt ablation; exact per-image inputs are saved in records.json" if args.ablation else
                             "original C prompt without dongzu trigger; compact layout-aware negative prompt; all original C concepts retained")}
(out / "protocol.json").write_text(json.dumps(protocol, indent=2), "utf-8")
pipe = service.load_pipeline()
pipe.set_progress_bar_config(disable=True)
records = []
for task in tasks:
    old = json.loads((ROOT / f"outputs/reproduction-2026-11-09-v2/runs/{task['id']}-C.json").read_text("utf-8"))["generation"]
    prompt = old["prompt"].removeprefix("dongzu, ")
    negative = "picture frame, decorative frame, ornamental border, carpet, rug, tapestry, watermark, text, blurry, low quality, photograph, cropped, cut off"
    if task["id"] == "T05":
        negative += ", vertical stripes, checkerboard"
    else:
        negative += ", tiled, repeating pattern, multiple panels"
    for variant in variants:
        variant_prompt = prompt
        variant_negative = negative
        if variant["id"] == "no-trigger-old-negative":
            variant_negative = old["negative_prompt"]
        elif variant["id"] == "trigger-new-negative":
            variant_prompt = old["prompt"]
        elif variant["id"] == "no-trigger-hoop-negative":
            variant_negative = "embroidery hoop, circular frame, " + negative
        for index in range(2):
            seed = task["seed"] + index
            path = out / f"{task['id']}-{variant['id']}-{seed}.png"
            record = {"task": task["id"], "variant": variant["id"], "seed": seed, "prompt": variant_prompt,
                      "negative": variant_negative, "scale": variant["scale"], "delay": variant["delay"], "path": str(path)}
            if not path.exists():
                pipe.set_adapters(service.ADAPTER_NAME, adapter_weights=0. if variant["delay"] else variant["scale"])
                def callback(pipeline, step, timestep, values):
                    if step + 1 == math.ceil(len(pipeline.scheduler.timesteps) * variant["delay"]):
                        pipeline.set_adapters(service.ADAPTER_NAME, adapter_weights=variant["scale"])
                    return values
                image = pipe(prompt=variant_prompt, negative_prompt=variant_negative, num_inference_steps=30, guidance_scale=7.2,
                             width=512, height=512, generator=service.TORCH.Generator(device=pipe.device).manual_seed(seed),
                             callback_on_step_end=callback).images[0]
                image.save(path)
                print(path.name, flush=True)
            records.append(record)
            (out / "records.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), "utf-8")
    sheet = Image.new("RGB", ((len(variants) + 1) * 300, 2 * 330), "white")
    draw = ImageDraw.Draw(sheet)
    for row in range(2):
        draw.text((5, row * 330 + 5), f"{task['id']} old C / {task['seed'] + row}", fill="black")
        sheet.paste(Image.open(old["candidates"][row]["path"]).resize((300, 300)), (0, row * 330 + 30))
        for column, variant in enumerate(variants, 1):
            draw.text((column * 300 + 5, row * 330 + 5), variant["id"], fill="black")
            path = out / f"{task['id']}-{variant['id']}-{task['seed'] + row}.png"
            sheet.paste(Image.open(path).resize((300, 300)), (column * 300, row * 330 + 30))
    sheet.save(out / f"{task['id']}-comparison.png")
pipe.set_adapters(service.ADAPTER_NAME, adapter_weights=1.)

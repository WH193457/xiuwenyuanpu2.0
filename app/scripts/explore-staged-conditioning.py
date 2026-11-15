"""Fixed-input exploration of early layout and later textile conditioning."""
import argparse
import json
import math
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("HF_HOME", str(ROOT.parent / "lora-scripts-main/huggingface"))
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
os.environ.setdefault("XFORMERS_FORCE_DISABLE_TRITON", "1")
import lora_service as service
from PIL import Image, ImageDraw
from prompt_plan import compile_plan, token_count

parser = argparse.ArgumentParser()
parser.add_argument("--layout-hints", action="store_true")
args = parser.parse_args()
out = ROOT / ("outputs/layout-hints-exploration-2026-11-09" if args.layout_hints else "outputs/staged-conditioning-exploration-2026-11-09")
out.mkdir(exist_ok=True)
manifest = json.loads((ROOT / "outputs/reproduction-2026-11-09-v2/manifest.json").read_text("utf-8"))
tasks = [task for task in manifest["tasks"] if task["id"] in ("T01", "T03", "T04", "T05", "T07", "T08")]
variants = [{"id": "early35", "fraction": .35}, {"id": "early60", "fraction": .60}]
anchors = {
    "T01": "recognizable butterfly silhouette with wings and antennae",
    "T02": "recognizable phoenix bird silhouette with head wings and tail",
    "T03": "one flower with visible petals arranged around its center",
    "T04": "one star with eight distinct pointed rays",
    "T05": "one continuous horizontal zigzag strip",
    "T06": "one complete coiled dragon with visible head and tail",
    "T07": "recognizable fish silhouette with visible fins and tail",
    "T08": "people holding hands in one horizontal row",
}
if args.layout_hints:
    tasks = manifest["tasks"]
    variants = [{"id": "layout", "fraction": 0}, {"id": "layout-anchors", "fraction": 0}]
protocol = {"purpose": "engineering exploration", "tasks": [t["id"] for t in tasks], "seedOffsets": [0, 2],
            "variants": variants, "loraScale": .35, "steps": 30, "guidance": 7.2,
            "method": ("Prepend explicit full-view/plain-ground or horizontal-strip layout hints, with/without recognizable subject morphology. Keep all original canvas concepts. Same negative prompt and LoRA. No postprocessing." if args.layout_hints else
                       "Early conditioning retains subject/composition/palette. Switch to the entire original accepted canvas after the fixed fraction of actual scheduler timesteps. Same negative prompt throughout. No postprocessing.")}
(out / "protocol.json").write_text(json.dumps(protocol, ensure_ascii=False, indent=2), "utf-8")
pipe = service.load_pipeline()
pipe.set_progress_bar_config(disable=True)
pipe.set_adapters(service.ADAPTER_NAME, adapter_weights=.35)
records = []
for task in tasks:
    payload = {"semantic_plan": task["knowledgePlan"], "generation_profile": "subject-fidelity"}
    late = service.preview_prompt(payload, pipe.tokenizer)
    early_plan = {**task["knowledgePlan"], "concepts": [c for c in task["knowledgePlan"]["concepts"]
                  if c["dimension"] in ("subject", "composition", "palette")]}
    early = compile_plan(early_plan, pipe.tokenizer, subject_first=True)["prompt"]
    with service.TORCH.no_grad():
        late_positive, late_negative = pipe.encode_prompt(late["prompt"], pipe.device, 1, True,
                                                          negative_prompt=late["negative_prompt"])
        late_embeddings = service.TORCH.cat([late_negative, late_positive])
    for variant in variants:
        input_prompt = early
        if args.layout_hints:
            layout = "one horizontal strip across the center, empty space above and below" if task["id"] in ("T05", "T08") else "complete motif fully visible, plain unpatterned background"
            hints = layout + (", " + anchors[task["id"]] if variant["id"] == "layout-anchors" else "")
            input_prompt = hints + ", " + late["prompt"]
            assert token_count(pipe.tokenizer, input_prompt) <= 77, (task["id"], input_prompt)
        for offset in (0, 2):
            seed = task["seed"] + offset
            path = out / f"{task['id']}-{variant['id']}-{seed}.png"
            record = {"task": task["id"], "variant": variant["id"], "seed": seed, "earlyPrompt": input_prompt,
                      "latePrompt": late["prompt"], "negative": late["negative_prompt"], "fraction": variant["fraction"], "path": str(path)}
            if not path.exists():
                def callback(pipeline, index, timestep, values):
                    switch_after = math.ceil(len(pipeline.scheduler.timesteps) * variant["fraction"])
                    if index + 1 == switch_after:
                        values["prompt_embeds"] = late_embeddings
                        record["switchAfterStep"] = switch_after
                        record["schedulerTimesteps"] = len(pipeline.scheduler.timesteps)
                    return values
                image = pipe(prompt=input_prompt, negative_prompt=late["negative_prompt"], num_inference_steps=30,
                             guidance_scale=7.2, width=512, height=512,
                             generator=service.TORCH.Generator(device=pipe.device).manual_seed(seed),
                             callback_on_step_end=callback, callback_on_step_end_tensor_inputs=["prompt_embeds"]).images[0]
                image.save(path)
                print(path.name, flush=True)
            records.append(record)
            (out / "records.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), "utf-8")
    sheet = Image.new("RGB", (900, 660), "white")
    draw = ImageDraw.Draw(sheet)
    for row, offset in enumerate((0, 2)):
        seed = task["seed"] + offset
        # Resolve actual copied baseline naming from the validated summary.
        summary = json.loads((ROOT / "outputs/subject-fidelity-validation-2026-11-09/summary.json").read_text("utf-8"))
        sample = next(s for s in summary["samples"] if s["taskId"] == task["id"] and s["methodId"] == "F" and s["seed"] == seed)
        baseline = Path(sample["path"])
        draw.text((5, row * 330 + 5), f"{task['id']} F / {seed}", fill="black")
        sheet.paste(Image.open(baseline).resize((300, 300)), (0, row * 330 + 30))
        for column, variant in enumerate(variants, 1):
            draw.text((column * 300 + 5, row * 330 + 5), variant["id"], fill="black")
            path = out / f"{task['id']}-{variant['id']}-{seed}.png"
            sheet.paste(Image.open(path).resize((300, 300)), (column * 300, row * 330 + 30))
    sheet.save(out / f"{task['id']}-comparison.png")
pipe.set_adapters(service.ADAPTER_NAME, adapter_weights=1.)

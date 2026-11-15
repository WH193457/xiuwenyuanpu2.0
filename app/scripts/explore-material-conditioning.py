"""Compare flat and stitched input conditioning before diffusion, with fixed seeds."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("reference_exploration", ROOT / "scripts/explore-reference-control.py")
exploration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exploration)
import reference_conditioning as references
from embroidery_texture_probe import materialize
from PIL import Image, ImageDraw

OUT = ROOT / "outputs/reference-material-exploration-2026-11-09"
service = exploration.service
service.EMBROIDERY_PROMPT = "close-up embroidery photograph, raised parallel silk stitches, individual thread fibers, woven cotton fabric"
original_render = references._render
original_version = references.PREPROCESSOR_VERSION
probe_version = original_version + "-material-probe-1"
references.SUPPORTED_PREPROCESSORS = (*references.SUPPORTED_PREPROCESSORS, probe_version)


def stitched_render(image, settings):
    images, warnings = original_render(image, settings)
    images["init"] = materialize(images["init"], images["mask"])
    return images, warnings


def main():
    OUT.mkdir(exist_ok=True)
    records = []
    for case in exploration.CASES:
        for mode in ("flat", "stitched"):
            references._render = original_render if mode == "flat" else stitched_render
            references.PREPROCESSOR_VERSION = original_version if mode == "flat" else probe_version
            prepared = references.prepare_reference({key: value for key, value in case.items() if key not in ("id", "prompt", "seed")} |
                {"palette_mode": "solid", "margin": .12, "width": 512, "height": 512})
            config = {"reference_id": prepared["reference_id"], "reference_sha256": prepared["reference_sha256"],
                      "method": "canny-img2img", "strength": .55, "control_scale": .8, "embroidery_detail": True}
            ref = references.load_reference_conditioning(config)
            ref["image"].save(OUT / f"{case['id']}-{mode}-init.png")
            plan = {"version": 1, "concepts": [{"id": "subject", "dimension": "subject", "label": case["id"],
                "promptText": case["prompt"], "priority": 3, "enabled": True, "patternIds": [case["pattern_id"]],
                "sourceIds": [], "evidence": "user"}], "extraPrompt": ""}
            payload = {"semantic_plan": plan, "generation_profile": "subject-fidelity", "pattern_id": case["pattern_id"],
                "reference_conditioning": config, "seed": case["seed"], "count": 2, "lora_scale": .35,
                "steps": 30, "guidance": 7.2, "width": 512, "height": 512}
            result = service.generate(payload)
            result.pop("image_data_url", None)
            for item in result["candidates"]:
                item.pop("image", None)
            records.append({"case": case["id"], "mode": mode, "payload": payload, "result": result})
            (OUT / "records.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), "utf-8")
            print(case["id"], mode, result["inference_seconds"], flush=True)
        sheet = Image.new("RGB", (1200, 660), "white")
        draw = ImageDraw.Draw(sheet)
        for row in range(2):
            for column, mode in enumerate(("flat", "stitched")):
                x = column * 600
                draw.text((x + 5, row * 330 + 5), f"{mode} input / seed {case['seed'] + row}", fill="black")
                sheet.paste(Image.open(OUT / f"{case['id']}-{mode}-init.png").resize((300, 300)), (x, row * 330 + 30))
                draw.text((x + 305, row * 330 + 5), "raw diffusion output", fill="black")
                record = next(r for r in records if r["case"] == case["id"] and r["mode"] == mode)
                path = record["result"]["candidates"][row]["path"]
                sheet.paste(Image.open(path).resize((300, 300)), (x + 300, row * 330 + 30))
        sheet.save(OUT / f"{case['id']}-comparison.png")
    (OUT / "protocol.json").write_text(json.dumps({"type": "engineering exploration",
        "cases": exploration.CASES, "texture_prompt": service.EMBROIDERY_PROMPT,
        "method": "canny-img2img", "strength": .55, "control_scale": .8, "lora_scale": .35,
        "material": "deterministic stitch and cloth shading applied to the input before diffusion",
        "postprocessing": "none", "count": 2, "steps": 30, "guidance": 7.2, "size": [512, 512]}, indent=2), "utf-8")


if __name__ == "__main__":
    main()

"""Exploratory deterministic material shading for diffusion input images.

This script reuses the production materializer and writes input previews only.
The output is an RGB conditioning image with the original mask and dimensions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from embroidery_material import MATERIAL_VERSION as PROBE_VERSION, NOISE_SEED, materialize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=PROJECT_ROOT / "outputs" / "reference-texture-exploration-2026-11-09")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "outputs" / "reference-material-probe-2026-11-09")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    sheet = Image.new("RGB", (1024, 4 * 544), "#ECE8DF")
    draw = ImageDraw.Draw(sheet)
    for index, name in enumerate(("butterfly", "star", "people", "zigzag")):
        image_path = args.source / f"{name}-init.png"
        mask_path = args.source / f"{name}-mask.png"
        with Image.open(image_path) as input_file, Image.open(mask_path) as mask_file:
            image, mask = input_file.convert("RGB"), mask_file.convert("L")
        result = materialize(image, mask)
        assert result.size == image.size
        assert result.tobytes() == materialize(image, mask).tobytes(), "Material input must be deterministic"
        destination = args.output / f"{name}-material.png"
        result.save(destination)
        original, rendered = np.array(image), np.array(result)
        outside = np.array(mask) == 0
        inside = np.array(mask) >= 128
        original_background = original[outside].mean(axis=0)
        material_background = rendered[outside].mean(axis=0)
        assert np.array_equal(original[outside].sum(axis=0), rendered[outside].sum(axis=0)), "Background mean changed"
        records.append({"name": name, "input": str(image_path), "mask": str(mask_path), "output": str(destination),
            "input_sha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
            "mask_sha256": hashlib.sha256(mask_path.read_bytes()).hexdigest(),
            "output_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
            "size": list(result.size), "background_mean_before": original_background.tolist(),
            "background_mean_after": material_background.tolist(),
            "foreground_mean_before": original[inside].mean(axis=0).tolist(),
            "foreground_mean_after": rendered[inside].mean(axis=0).tolist()})
        draw.text((12, index * 544 + 8), name + " - prepared input", fill="#222222")
        draw.text((524, index * 544 + 8), name + " - material input probe", fill="#222222")
        sheet.paste(image, (0, index * 544 + 32))
        sheet.paste(result, (512, index * 544 + 32))
    sheet.save(args.output / "material-input-comparison.png")
    report = {"version": PROBE_VERSION, "noise_seed": NOISE_SEED,
        "scope": "Deterministic pre-diffusion conditioning exploration. Production preprocessing and generated outputs are unchanged.",
        "records": records}
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "version": PROBE_VERSION,
        "checked": ["four source masks and sizes retained", "deterministic pixels", "exact outside-mask channel means"],
        "foreground_means": [{"name": row["name"], "before": row["foreground_mean_before"], "after": row["foreground_mean_after"]} for row in records]}, indent=2))


if __name__ == "__main__":
    main()

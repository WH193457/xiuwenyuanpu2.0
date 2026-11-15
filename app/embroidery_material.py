"""Deterministic satin-thread material for pre-diffusion reference images."""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

MATERIAL_VERSION = "embroidery-input-material-1"
NOISE_SEED = 20261109


def _restore_background_mean(output, source, outside):
    """Keep each integer channel sum outside the source mask unchanged."""
    if not np.any(outside):
        return output
    for channel in range(3):
        values = output[:, :, channel][outside].astype(np.int32)
        target = int(source[:, :, channel][outside].sum())
        for _ in range(4):
            difference = target - int(values.sum())
            if difference == 0:
                break
            direction = 1 if difference > 0 else -1
            editable = np.flatnonzero(values < 255 if direction > 0 else values > 0)
            if not editable.size:
                break
            quotient, remainder = divmod(abs(difference), editable.size)
            values[editable] += direction * quotient
            # Evenly spaced corrections keep the small quantization adjustment
            # from appearing as a bright patch in one corner of the fabric.
            if remainder:
                indices = np.linspace(0, editable.size - 1, remainder, dtype=int)
                values[editable[indices]] += direction
            values = np.clip(values, 0, 255)
        output[:, :, channel][outside] = values.astype(np.uint8)
    return output


def materialize(image: Image.Image, mask: Image.Image) -> Image.Image:
    """Add restrained satin/thread relief and weave to a prepared RGB image."""
    if image.size != mask.size:
        raise ValueError("Material image and mask must have identical dimensions.")
    rgb = np.array(image.convert("RGB"))
    opacity = np.array(mask.convert("L"))
    alpha = opacity.astype(np.float32) / 255
    height, width = alpha.shape
    scale = min(width, height) / 512
    y, x = np.mgrid[:height, :width].astype(np.float32)
    angle = np.deg2rad(-28)
    across = x * np.cos(angle) + y * np.sin(angle)
    along = -x * np.sin(angle) + y * np.cos(angle)
    random = np.random.default_rng(NOISE_SEED)
    grain = random.normal(0, 1, alpha.shape).astype(np.float32)

    # Fine, almost parallel cylinders, with slight yarn irregularity along their
    # length. Pitch is about four pixels at the project's 512px working size.
    drift = 0.10 * scale * np.sin(along / (19 * scale))
    pitch = 4.1 * scale
    phase = ((across + drift) / pitch + 0.5) % 1 - 0.5
    cylinder_x = np.clip(phase / 0.47, -1, 1)
    cylinder_z = np.sqrt(np.maximum(0, 1 - cylinder_x ** 2))
    directional_light = 0.78 * cylinder_z - 0.24 * cylinder_x
    yarn = directional_light - 0.58
    fibers = np.sin(2 * np.pi * (across / (0.86 * scale) + 0.015 * np.sin(along / (8 * scale))))
    specular = np.maximum(0, directional_light - 0.72) ** 2 * 110
    foreground_delta = rgb.astype(np.float32) * (yarn[:, :, None] * 0.30)
    # A small neutral specular component makes dark thread visible without
    # replacing its selected color with a lighter material preset.
    foreground_delta += (specular + fibers * 1.1 + grain * 0.65)[:, :, None]

    support = (opacity >= max(16, min(128, (int(opacity.max()) + 1) // 2))).astype(np.uint8)
    distance = cv2.distanceTransform(support, cv2.DIST_L2, 3)
    surface = np.clip(distance / max(1, 2.5 * scale), 0, 1)
    slope_y, slope_x = np.gradient(surface)
    bevel = (-0.7 * slope_x - 0.5 * slope_y) * 13
    foreground_delta += bevel[:, :, None]

    warp = np.sin(2 * np.pi * x / (3.1 * scale))
    weft = np.sin(2 * np.pi * y / (2.8 * scale))
    weave = (0.65 * warp + 0.6 * weft + 0.3 * warp * weft + grain * 0.25) * 1.3
    composite = rgb.astype(np.float32) + foreground_delta * alpha[:, :, None] + weave[:, :, None] * (1 - alpha[:, :, None])
    output = np.clip(np.rint(composite), 0, 255).astype(np.uint8)
    output = _restore_background_mean(output, rgb, opacity == 0)
    return Image.fromarray(output, "RGB")


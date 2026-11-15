"""Download the official pinned ControlNet Canny FP16 safetensors checkpoint.

Uses the bounded, resumable range-download approach in setup-evaluation-model.py.
No inference, dependency installation, or GPU allocation is performed.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time
from urllib.parse import urlparse

import requests


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIRECTORY = ROOT / ".model-cache" / "control_v11p_sd15_canny"
MODEL_ID = "lllyasviel/control_v11p_sd15_canny"
REVISION = "115a470d547982438f70198e353a921996e2e819"
NAME = "diffusion_pytorch_model.fp16.safetensors"
SIZE = 722_598_642
SHA256 = "9ed3a7f834aca0d2b26f9c7f186b3ee29465de1d13e152459e8c9cbb25a0c0bc"
BASE_URL = f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}"
PART_DIRECTORY = MODEL_DIRECTORY / f".controlnet-download-parts-{REVISION[:8]}"
PART_BYTES = 4 * 1024 * 1024
MAX_ATTEMPTS = 4
SMALL_FILES = {
    "config.json": {"bytes": 996, "git_blob_sha1": "ebd8387e9b5a9c67032880f7799042436ef94efb"},
    "README.md": {"bytes": 16599, "git_blob_sha1": "cc466f57e92eb07ca04a188252688556f1a0db80"},
}


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_host(url: str) -> None:
    hostname = urlparse(url).hostname or ""
    if hostname != "huggingface.co" and not hostname.endswith(".hf.co"):
        raise ValueError("Official file redirected outside the Hugging Face CDN")


def download_small_files() -> list[dict]:
    records = []
    for name, expected in SMALL_FILES.items():
        target = MODEL_DIRECTORY / name
        url = f"{BASE_URL}/{name}"
        for attempt in range(MAX_ATTEMPTS):
            try:
                with requests.get(url, timeout=(10, 30)) as response:
                    response.raise_for_status()
                    verify_host(response.url)
                    data = response.content
                blob_hash = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
                if len(data) != expected["bytes"] or blob_hash != expected["git_blob_sha1"]:
                    raise ValueError(f"{name} differs from its pinned official Git blob")
                temporary = target.with_suffix(f".{os.getpid()}.download")
                temporary.write_bytes(data)
                temporary.replace(target)
                records.append({"file": name, "source": url, "bytes": len(data),
                                "sha256": hashlib.sha256(data).hexdigest(), "git_blob_sha1": blob_hash})
                break
            except (requests.RequestException, OSError, ValueError):
                if attempt + 1 == MAX_ATTEMPTS:
                    raise
                time.sleep(2 * (attempt + 1))
    return records


def resolve_download_url() -> str:
    for attempt in range(MAX_ATTEMPTS):
        try:
            with requests.get(f"{BASE_URL}/{NAME}?download=true",
                              headers={"Range": "bytes=0-0", "Accept-Encoding": "identity"},
                              stream=True, timeout=(10, 20)) as response:
                response.raise_for_status()
                verify_host(response.url)
                if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes 0-0/{SIZE}":
                    raise ValueError("Official host returned an unexpected probe range")
                return response.url
        except (requests.RequestException, ValueError):
            if attempt + 1 == MAX_ATTEMPTS:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("Official file resolution exhausted retries")


def download_part(index: int, download_url: str) -> Path:
    start = index * PART_BYTES
    end = min(SIZE, start + PART_BYTES) - 1
    expected_size = end - start + 1
    target = PART_DIRECTORY / f"{index:04d}.part"
    if target.is_file() and target.stat().st_size == expected_size:
        return target
    temporary = target.with_suffix(f".{os.getpid()}.tmp")
    for attempt in range(MAX_ATTEMPTS):
        try:
            started = time.monotonic()
            with requests.get(download_url,
                              headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"},
                              stream=True, timeout=(10, 20)) as response:
                response.raise_for_status()
                verify_host(response.url)
                if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{SIZE}":
                    raise ValueError("Official host returned an unexpected byte range or total size")
                received = 0
                with temporary.open("wb") as stream:
                    for block in response.iter_content(256 * 1024):
                        received += len(block)
                        if received > expected_size or time.monotonic() - started > 60:
                            raise ValueError("Model part exceeded its size or time budget")
                        stream.write(block)
                if received != expected_size:
                    raise ValueError("Model part is incomplete")
            temporary.replace(target)
            return target
        except (requests.RequestException, OSError, ValueError) as error:
            print(f"Part {index}, attempt {attempt + 1}/{MAX_ATTEMPTS}: {type(error).__name__}", flush=True)
            if attempt + 1 == MAX_ATTEMPTS:
                raise RuntimeError(f"Part {index} exhausted bounded download retries") from error
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("Download attempts exhausted")


def download_weight() -> None:
    target = MODEL_DIRECTORY / NAME
    if target.is_file() and target.stat().st_size == SIZE and checksum(target) == SHA256:
        print(f"Already verified {NAME} SHA256 {SHA256}", flush=True)
        return
    PART_DIRECTORY.mkdir(parents=True, exist_ok=True)
    count = (SIZE + PART_BYTES - 1) // PART_BYTES
    started = time.monotonic()
    download_url = resolve_download_url()
    with ThreadPoolExecutor(max_workers=4) as pool:
        tasks = [pool.submit(download_part, index, download_url) for index in range(count)]
        try:
            for completed, task in enumerate(as_completed(tasks), 1):
                task.result()
                if completed % 8 == 0 or completed == count:
                    print(f"Downloaded {completed}/{count} ranges in {time.monotonic() - started:.1f}s", flush=True)
        except Exception:
            for task in tasks:
                task.cancel()
            raise
    temporary = target.with_suffix(f".{os.getpid()}.verified-download")
    digest = hashlib.sha256()
    with temporary.open("wb") as destination:
        for index in range(count):
            with (PART_DIRECTORY / f"{index:04d}.part").open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
                    destination.write(block)
    if temporary.stat().st_size != SIZE or digest.hexdigest() != SHA256:
        raise RuntimeError("Downloaded ControlNet weight differs from the pinned official SHA256")
    temporary.replace(target)
    # Remove only this script's enumerated chunks after verifying the final file.
    workspace = ROOT.resolve()
    model_directory = MODEL_DIRECTORY.resolve()
    part_directory = PART_DIRECTORY.resolve()
    if not model_directory.is_relative_to(workspace / ".model-cache") or not part_directory.is_relative_to(model_directory):
        raise RuntimeError("Temporary chunk cleanup target is outside the expected model cache")
    for index in range(count):
        (part_directory / f"{index:04d}.part").unlink()
    if not any(part_directory.iterdir()):
        part_directory.rmdir()
    print(f"Verified {NAME} SHA256 {SHA256} in {time.monotonic() - started:.1f}s", flush=True)


def main() -> None:
    MODEL_DIRECTORY.mkdir(parents=True, exist_ok=True)
    files = download_small_files()
    download_weight()
    files.append({"file": NAME, "source": f"{BASE_URL}/{NAME}", "bytes": SIZE, "sha256": SHA256})
    verification = {
        "model": MODEL_ID, "revision": REVISION,
        "metadata_source": f"https://huggingface.co/api/models/{MODEL_ID}/revision/{REVISION}?blobs=true",
        "license": "CreativeML OpenRAIL-M", "license_model_card_tag": "openrail",
        "license_source": "https://huggingface.co/spaces/CompVis/stable-diffusion-license",
        "model_card_source": f"https://huggingface.co/{MODEL_ID}/blob/{REVISION}/README.md",
        "variant": "fp16", "use_safetensors": True,
        "verified_at": datetime.now(timezone.utc).isoformat(), "files": files,
    }
    (MODEL_DIRECTORY / "download-verification.json").write_text(json.dumps(verification, indent=2), encoding="utf-8")
    print(f"Ready: {MODEL_DIRECTORY}", flush=True)


if __name__ == "__main__":
    main()

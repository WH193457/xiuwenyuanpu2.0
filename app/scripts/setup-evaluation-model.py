"""Fetch the pinned official CLIP weight in resumable, verified byte ranges."""

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
MODEL_DIRECTORY = ROOT / ".model-cache" / "clip-vit-base-patch32"
REVISION = "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"
NAME = "pytorch_model.bin"
SIZE = 605_247_071
SHA256 = "a63082132ba4f97a80bea76823f544493bffa8082296d62d71581a4feff1576f"
URL = f"https://huggingface.co/openai/clip-vit-base-patch32/resolve/{REVISION}/{NAME}?download=true"
PART_DIRECTORY = MODEL_DIRECTORY / f".clip-download-parts-{REVISION[:8]}"
PART_BYTES = 4 * 1024 * 1024
MAX_ATTEMPTS = 4


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def resolve_download_url() -> str:
    # Resolve the pinned official file once so every range uses the same CDN URL.
    for attempt in range(MAX_ATTEMPTS):
        try:
            with requests.get(URL, headers={"Range": "bytes=0-0", "Accept-Encoding": "identity"}, stream=True, timeout=(10, 20)) as response:
                response.raise_for_status()
                if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes 0-0/{SIZE}":
                    raise ValueError("Official host returned an unexpected probe range")
                hostname = urlparse(response.url).hostname or ""
                if hostname != "huggingface.co" and not hostname.endswith(".hf.co"):
                    raise ValueError("Official file redirected outside the Hugging Face CDN")
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
    destination = PART_DIRECTORY / f"{index:04d}.part"
    if destination.is_file() and destination.stat().st_size == expected_size:
        return destination
    temporary = destination.with_suffix(f".{os.getpid()}.tmp")
    for attempt in range(MAX_ATTEMPTS):
        try:
            started = time.monotonic()
            headers = {"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"}
            with requests.get(download_url, headers=headers, stream=True, timeout=(10, 20)) as response:
                response.raise_for_status()
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
            temporary.replace(destination)
            return destination
        except (requests.RequestException, OSError, ValueError) as error:
            print(f"Part {index}, attempt {attempt + 1}/{MAX_ATTEMPTS}: {type(error).__name__}", flush=True)
            if attempt + 1 == MAX_ATTEMPTS:
                raise RuntimeError(f"Part {index} exhausted bounded download retries") from error
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("Download attempts exhausted")


def main() -> None:
    MODEL_DIRECTORY.mkdir(parents=True, exist_ok=True)
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
                    print(f"Downloaded {completed}/{count} verified ranges in {time.monotonic() - started:.1f}s", flush=True)
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
        raise RuntimeError("Downloaded CLIP weight does not match the pinned official SHA256")
    temporary.replace(target)
    verification = {
        "model": "openai/clip-vit-base-patch32", "revision": REVISION,
        "source": URL, "file": NAME, "bytes": SIZE, "sha256": SHA256,
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }
    (MODEL_DIRECTORY / "download-verification.json").write_text(json.dumps(verification, indent=2), encoding="utf-8")
    for index in range(count):
        (PART_DIRECTORY / f"{index:04d}.part").unlink()
    print(f"Verified {NAME} SHA256 {SHA256} in {time.monotonic() - started:.1f}s", flush=True)


if __name__ == "__main__":
    main()

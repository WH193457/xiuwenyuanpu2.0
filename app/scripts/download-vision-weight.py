"""Resume the Qwen-published weight from its official ModelScope mirror.

The final SHA256 is the Hugging Face pinned revision's X-Linked-ETag.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
from pathlib import Path
import time

import requests

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIRECTORY = ROOT / ".model-cache" / "Qwen2-VL-2B-Instruct"
NAME = "model-00001-of-00002.safetensors"
SIZE = 3_988_609_112
SHA256 = "994ac2b03f97de8bc647d0fe5eba2e4b632b3e28dc03574c29bdfc36cf47e1b9"
URL = f"https://www.modelscope.cn/models/Qwen/Qwen2-VL-2B-Instruct/resolve/master/{NAME}"
CHUNK_SIZE = 16 * 1024 * 1024


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download_part(index: int) -> Path:
    start = index * CHUNK_SIZE
    end = min(SIZE, start + CHUNK_SIZE) - 1
    path = MODEL_DIRECTORY / ".download-parts" / f"{index:04d}.part"
    if path.exists() and path.stat().st_size == end - start + 1:
        return path
    for attempt in range(4):
        try:
            with requests.get(URL, headers={"Range": f"bytes={start}-{end}"}, stream=True, timeout=(15, 45)) as response:
                response.raise_for_status()
                if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{SIZE}":
                    raise ValueError("The model host returned an unexpected byte range.")
                temporary = path.with_suffix(".tmp")
                with temporary.open("wb") as stream:
                    for block in response.iter_content(1024 * 1024):
                        stream.write(block)
                if temporary.stat().st_size != end - start + 1:
                    raise ValueError("The model part is incomplete.")
                temporary.replace(path)
                return path
        except (requests.RequestException, OSError, ValueError):
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("Download retries exhausted.")


def main() -> None:
    target = MODEL_DIRECTORY / NAME
    if target.exists() and target.stat().st_size == SIZE and checksum(target) == SHA256:
        print("The local vision weight is already verified.", flush=True)
        return
    (MODEL_DIRECTORY / ".download-parts").mkdir(parents=True, exist_ok=True)
    count = (SIZE + CHUNK_SIZE - 1) // CHUNK_SIZE
    with ThreadPoolExecutor(max_workers=6) as pool:
        tasks = [pool.submit(download_part, index) for index in range(count)]
        for done, task in enumerate(as_completed(tasks), 1):
            task.result()
            if done % 10 == 0 or done == count:
                print(f"Downloaded {done}/{count} parts", flush=True)
    temporary = target.with_suffix(".download")
    digest = hashlib.sha256()
    with temporary.open("wb") as destination:
        for index in range(count):
            with (MODEL_DIRECTORY / ".download-parts" / f"{index:04d}.part").open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    destination.write(block)
                    digest.update(block)
    if temporary.stat().st_size != SIZE or digest.hexdigest() != SHA256:
        raise RuntimeError("The downloaded model does not match the pinned official SHA256.")
    temporary.replace(target)
    for index in range(count):
        (MODEL_DIRECTORY / ".download-parts" / f"{index:04d}.part").unlink()
    print(f"Verified {NAME} SHA256 {SHA256}", flush=True)


if __name__ == "__main__":
    main()

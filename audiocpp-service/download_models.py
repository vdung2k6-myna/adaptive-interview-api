#!/usr/bin/env python3
"""Provision the Qwen3-ASR model used by the audio.cpp STT service.

Pinned to a Hugging Face revision and verified by size and SHA-256, so two
provisionings of the same revision produce the same bytes. The file lives
outside the image; see README.md.

Usage:
    python download_models.py                  # into <repo>/audio-models/audiocpp
    python download_models.py --dest D:/models
"""

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

REPO = "audio-cpp/audio.cpp-gguf"
REVISION = "02f5de92a82339ebb722ea6fdadc14b7bec43a7f"
REMOTE_PATH = "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf"
EXPECTED_SIZE = 2_473_017_600
EXPECTED_SHA256 = "3bc2462eca3a3a8f56abcd860d0943ffdc0546547dde55a9d08589607d6f3936"

DEFAULT_DEST = Path(__file__).resolve().parent.parent / "audio-models" / "audiocpp"
URL = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{REMOTE_PATH}"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: Path) -> bool:
    size = path.stat().st_size
    if size != EXPECTED_SIZE:
        print(f"  size mismatch: {size} != {EXPECTED_SIZE}", file=sys.stderr)
        return False
    actual = sha256_of(path)
    if actual != EXPECTED_SHA256:
        print(f"  sha256 mismatch: {actual}", file=sys.stderr)
        return False
    return True


def download(dest_file: Path) -> None:
    dest_file.parent.mkdir(parents=True, exist_ok=True)
    part = dest_file.with_suffix(dest_file.suffix + ".part")

    request = urllib.request.Request(URL, headers={"User-Agent": "adaptive-interview-api"})
    with urllib.request.urlopen(request, timeout=120) as response:
        total = int(response.headers.get("content-length", 0))
        written = 0
        with part.open("wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                written += len(chunk)
                if total:
                    pct = written * 100 / total
                    print(f"\r  {pct:5.1f}% ({written / 1024 / 1024:.0f} MB)", end="")
        print()

    if not verify(part):
        part.unlink(missing_ok=True)
        raise SystemExit(f"downloaded file failed verification: {part}")
    part.replace(dest_file)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dest",
        type=Path,
        default=DEFAULT_DEST,
        help=f"directory the model package is written under (default: {DEFAULT_DEST})",
    )
    args = parser.parse_args()

    dest_file = args.dest / REMOTE_PATH
    print(f"Model:    {REPO}@{REVISION[:12]}")
    print(f"Target:   {dest_file}")

    if dest_file.exists():
        print("Already present; verifying...")
        if verify(dest_file):
            print("  [OK] size and sha256 match; nothing to do.")
            return
        print("  [FAIL] present file does not match the pin; replacing.")
        dest_file.unlink()

    print("Downloading...")
    download(dest_file)
    print(f"  [OK] {dest_file}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Download Kokoro Vietnamese ONNX model and voicepack from Hugging Face.
Run once before starting the server.
"""

import os
import requests
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "models"
BASE_URL = "https://huggingface.co/contextboxai/Kokoro-Vietnamese/resolve/main"

FILES = {
    "kokoro_vi.onnx": f"{BASE_URL}/kokoro_vi.onnx",
    "kokoro_vi.pth": f"{BASE_URL}/kokoro_vi.pth",
    "kokoro_vi_voicepack.pt": f"{BASE_URL}/kokoro_vi_voicepack.pt",
    "config.json": f"{BASE_URL}/config.json",
}


def download_file(url: str, dest: Path) -> None:
    """Download a file with progress display."""
    print(f"Downloading {dest.name}...")
    response = requests.get(url, stream=True, timeout=300)
    response.raise_for_status()

    total_size = int(response.headers.get("content-length", 0))
    downloaded = 0
    chunk_size = 1024 * 1024  # 1MB

    with open(dest, "wb") as f:
        for chunk in response.iter_content(chunk_size=chunk_size):
            if chunk:
                f.write(chunk)
                downloaded += len(chunk)
                if total_size > 0:
                    percent = (downloaded / total_size) * 100
                    print(f"  {percent:.1f}% ({downloaded / 1024 / 1024:.1f}MB / {total_size / 1024 / 1024:.1f}MB)", end="\r")
    print(f"\n  [OK] Saved to {dest}")


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Models directory: {MODELS_DIR.resolve()}")

    for filename, url in FILES.items():
        dest = MODELS_DIR / filename
        if dest.exists():
            print(f"[OK] {filename} already exists ({dest.stat().st_size / 1024 / 1024:.1f}MB)")
            continue
        try:
            download_file(url, dest)
        except requests.HTTPError as e:
            print(f"  [ERR] Failed to download {filename}: {e}")
            if dest.exists():
                dest.unlink()
            raise

    print("\n[OK] All models downloaded successfully!")


if __name__ == "__main__":
    main()

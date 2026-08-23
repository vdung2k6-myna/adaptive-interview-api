#!/usr/bin/env python3
"""Inspect Piper AudioChunk object."""

from piper.voice import PiperVoice
from pathlib import Path
import numpy as np

onnx = Path("pipervoices/vais1000/medium/vi_VN-vais1000-medium.onnx")
cfg = onnx.with_suffix(".onnx.json")
voice = PiperVoice.load(str(onnx), config_path=str(cfg))

for chunk in voice.synthesize(text="Xin chao."):
    print("type:", type(chunk).__name__)
    attrs = [d for d in dir(chunk) if not d.startswith("_")]
    print("attrs:", attrs)

    for attr in attrs:
        try:
            val = getattr(chunk, attr)
            if callable(val):
                print(f"  {attr}: callable")
            else:
                print(f"  {attr}: type={type(val).__name__}, len={len(val) if hasattr(val, '__len__') else 'n/a'}")
        except Exception as e:
            print(f"  {attr}: ERROR {e}")
    break

print("\n--- Trying synthesize_raw ---")
try:
    for item in voice.synthesize_raw(text="Xin chao."):
        print("raw item type:", type(item).__name__)
        if hasattr(item, "tolist"):
            arr = np.array(item)
            print("  array shape:", arr.shape, "dtype:", arr.dtype)
        break
except Exception as e:
    print("synthesize_raw error:", e)

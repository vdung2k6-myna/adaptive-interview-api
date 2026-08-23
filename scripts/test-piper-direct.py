#!/usr/bin/env python3
"""Test Piper TTS library directly, bypassing FastAPI."""

import os
import io
import wave
import numpy as np
from pathlib import Path

MODELS_DIR = Path(os.environ.get("PIPER_MODELS_DIR", "pipervoices"))

def pcm_to_wav(pcm_bytes: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sample_rate)
        f.writeframes(pcm_bytes)
    return buf.getvalue()

def numpy_to_wav(audio_array: np.ndarray, sample_rate: int) -> bytes:
    audio_int16 = np.clip(audio_array * 32767, -32767, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sample_rate)
        f.writeframes(audio_int16.tobytes())
    return buf.getvalue()

def test_voice(voice_id: str, onnx_path: Path):
    from piper.voice import PiperVoice

    print(f"\n=== Testing {voice_id} ===")
    config_path = onnx_path.with_suffix(".onnx.json")
    print(f"Model: {onnx_path}")
    print(f"Config: {config_path} (exists={config_path.exists()})")

    voice = PiperVoice.load(str(onnx_path), config_path=str(config_path) if config_path.exists() else None)
    print(f"Voice loaded: {type(voice)}")
    print(f"Has synthesize: {hasattr(voice, 'synthesize')}")

    text = "Xin chao."
    print(f"Synthesizing: '{text}'")

    synthesizer = voice.synthesize(text=text)
    print(f"Synthesizer type: {type(synthesizer)}")

    audio_chunks = []
    chunk_count = 0
    for item in synthesizer:
        chunk_count += 1
        if isinstance(item, tuple) and len(item) >= 1:
            audio = item[0]
            print(f"  Chunk {chunk_count}: tuple[0] type={type(audio)}, len={len(audio) if hasattr(audio, '__len__') else 'n/a'}")
        else:
            audio = item
            print(f"  Chunk {chunk_count}: type={type(audio)}, len={len(audio) if hasattr(audio, '__len__') else 'n/a'}")

        if isinstance(audio, bytes):
            audio_chunks.append(audio)
        elif isinstance(audio, np.ndarray):
            audio_chunks.append(audio)

    print(f"Total chunks: {len(audio_chunks)}")

    if not audio_chunks:
        print("ERROR: No audio chunks!")
        return

    sample_rate = 22050
    if config_path.exists():
        import json
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            sample_rate = cfg.get("audio", {}).get("sample_rate", 22050)

    if isinstance(audio_chunks[0], np.ndarray):
        combined = np.concatenate(audio_chunks)
        wav = numpy_to_wav(combined, sample_rate)
    else:
        combined_pcm = b"".join(audio_chunks)
        wav = pcm_to_wav(combined_pcm, sample_rate)

    out_file = f"test_piper_{voice_id}.wav"
    with open(out_file, "wb") as f:
        f.write(wav)
    print(f"Saved {len(wav)} bytes to {out_file}")

if __name__ == "__main__":
    if not MODELS_DIR.exists():
        print(f"Models dir not found: {MODELS_DIR}")
        exit(1)

    for onnx_file in MODELS_DIR.rglob("*.onnx"):
        test_voice(onnx_file.stem, onnx_file)

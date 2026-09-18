#!/usr/bin/env python3
"""
Piper TTS FastAPI Service

Provides a lightweight HTTP API for text-to-speech synthesis
using Piper ONNX models.

Endpoints:
  POST /v1/audio/speech    - Synthesize text to WAV audio
  GET  /health             - Health check + available voices
"""

import io
import os
import traceback
import wave
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Configuration ──────────────────────────────────────────────────────

def _try_path(raw: str) -> Path | None:
    """Try to resolve a path string, handling Windows quirks."""
    raw = raw.strip()
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        raw = raw[1:-1]
    p = Path(raw)
    if p.exists():
        return p
    p2 = Path(raw.replace("\\", "/"))
    if p2.exists():
        return p2
    if os.path.exists(raw):
        return Path(raw)
    if os.path.exists(raw.replace("\\", "/")):
        return Path(raw.replace("\\", "/"))
    if len(raw) >= 2 and raw[1] == ":":
        lower_drive = raw[0].lower() + raw[1:]
        p3 = Path(lower_drive)
        if p3.exists():
            return p3
        if os.path.exists(lower_drive):
            return Path(lower_drive)
    return None


def _resolve_models_dir() -> Path:
    """Resolve the Piper models directory from env var or common locations."""
    raw = os.environ.get("PIPER_MODELS_DIR", "").strip()
    if raw:
        result = _try_path(raw)
        if result:
            return result

    # Fallback candidates — include project root
    _candidates = [
        str(Path(__file__).resolve().parent.parent / "pipervoices"),
        str(Path.cwd() / "pipervoices"),
        "D:/Working/pipervoices",
        "D:\\Working\\pipervoices",
        "d:/Working/pipervoices",
        "C:/Working/pipervoices",
        str(Path.home() / "pipervoices"),
        "/app/models",
    ]
    for cand in _candidates:
        result = _try_path(cand)
        if result:
            return result

    return Path("/app/models")


MODELS_DIR = _resolve_models_dir()
PORT = int(os.environ.get("PORT", "8083"))
HOST = os.environ.get("HOST", "127.0.0.1")

print(f"[Piper] Final models directory: {MODELS_DIR}")
print(f"[Piper] Directory exists: {MODELS_DIR.exists()}")

# ── App ────────────────────────────────────────────────────────────────
app = FastAPI(title="Piper TTS Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model loading ──────────────────────────────────────────────────────
_voices: dict[str, object] = {}
_voice_configs: dict[str, dict] = {}
_DEFAULT_VOICE: str = ""


def _discover_voices() -> dict[str, Path]:
    """Scan PIPER_MODELS_DIR for .onnx files and derive voice IDs."""
    voices: dict[str, Path] = {}
    if not MODELS_DIR.exists():
        print(f"[Piper] WARNING: Models directory does not exist: {MODELS_DIR}")
        return voices

    found = list(MODELS_DIR.rglob("*.onnx"))
    print(f"[Piper] Found {len(found)} .onnx file(s)")

    for onnx_file in found:
        voice_id = onnx_file.stem
        voices[voice_id] = onnx_file
        print(f"[Piper]   - {voice_id}: {onnx_file}")
    return voices


def _load_voices() -> None:
    """Load all discovered Piper voice models."""
    global _voices, _voice_configs, _DEFAULT_VOICE

    discovered = _discover_voices()
    if not discovered:
        print(f"[Piper] WARNING: No .onnx models found in {MODELS_DIR}")
        return

    try:
        from piper.voice import PiperVoice
    except ImportError:
        print("[Piper] ERROR: piper-tts package not installed. Run: pip install piper-tts")
        return

    for voice_id, onnx_path in discovered.items():
        config_path = onnx_path.with_suffix(".onnx.json")
        try:
            voice = PiperVoice.load(
                str(onnx_path),
                config_path=str(config_path) if config_path.exists() else None
            )
            _voices[voice_id] = voice
            if config_path.exists():
                import json
                with open(config_path, "r", encoding="utf-8") as f:
                    _voice_configs[voice_id] = json.load(f)
            print(f"[Piper] Loaded voice: {voice_id}")
        except Exception as exc:
            print(f"[Piper] Failed to load {voice_id}: {exc}")

    if _voices:
        _DEFAULT_VOICE = sorted(_voices.keys())[0]
        print(f"[Piper] Default voice: {_DEFAULT_VOICE}")
        print(f"[Piper] Total voices loaded: {len(_voices)}")
    else:
        print("[Piper] WARNING: No voices could be loaded.")


_load_voices()


# ── Request model ──────────────────────────────────────────────────────
class SynthesizeRequest(BaseModel):
    text: str
    voice: str
    speaker_id: int | None = None  # For multi-speaker models


# ── Helpers ────────────────────────────────────────────────────────────
def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int) -> bytes:
    """Wrap raw PCM bytes in a WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_bytes)
    return buf.getvalue()


def _get_sample_rate(voice_id: str) -> int:
    """Get sample rate from voice config, default to 22050."""
    cfg = _voice_configs.get(voice_id, {})
    return cfg.get("audio", {}).get("sample_rate", 22050)


# ── Endpoints ──────────────────────────────────────────────────────────
@app.post("/v1/audio/speech")
async def synthesize(req: SynthesizeRequest) -> Response:
    """Synthesize text to speech using Piper."""
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    voice_id = req.voice or _DEFAULT_VOICE
    if not voice_id:
        raise HTTPException(status_code=500, detail="No voices loaded")

    voice = _voices.get(voice_id)
    if not voice:
        available = sorted(_voices.keys())
        raise HTTPException(
            status_code=400,
            detail=f"Voice '{voice_id}' not found. Available: {available}"
        )

    try:
        sample_rate = _get_sample_rate(voice_id)

        synthesize_args: dict = {"text": req.text}
        if req.speaker_id is not None:
            synthesize_args["speaker_id"] = req.speaker_id

        synthesizer = voice.synthesize(**synthesize_args)
        pcm_chunks: list[bytes] = []
        chunk_count = 0

        for item in synthesizer:
            chunk_count += 1
            # PiperVoice.synthesize() yields AudioChunk objects
            if hasattr(item, "audio_int16_bytes"):
                # Preferred: direct PCM bytes from AudioChunk
                pcm_chunks.append(item.audio_int16_bytes)
                if hasattr(item, "sample_rate") and item.sample_rate:
                    sample_rate = item.sample_rate
            elif isinstance(item, tuple) and len(item) >= 1:
                audio = item[0]
                if isinstance(audio, bytes):
                    pcm_chunks.append(audio)
                elif hasattr(audio, "audio_int16_bytes"):
                    pcm_chunks.append(audio.audio_int16_bytes)
            elif isinstance(item, bytes):
                pcm_chunks.append(item)

        if not pcm_chunks:
            raise RuntimeError("Piper produced no audio data")

        combined_pcm = b"".join(pcm_chunks)
        wav_bytes = _pcm_to_wav(combined_pcm, sample_rate)
        return Response(content=wav_bytes, media_type="audio/wav")

    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}")


@app.get("/health")
async def health() -> dict:
    """Health check with loaded voice info."""
    return {
        "status": "ok" if _voices else "degraded",
        "voices_loaded": len(_voices),
        "voices": sorted(_voices.keys()),
        "default_voice": _DEFAULT_VOICE,
    }


# ── Entrypoint ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)

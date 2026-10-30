#!/usr/bin/env python3
"""
Kokoro TTS FastAPI Service

Provides a lightweight HTTP API for text-to-speech synthesis
using the Kokoro Vietnamese model.

Endpoints:
  POST /v1/audio/speech    - Synthesize text to WAV audio
  GET  /health             - Health check
"""

import io
import os
import threading
import traceback
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Configuration ──────────────────────────────────────────────────────
MODELS_DIR = Path(__file__).parent / "models"
MODEL_PATH = MODELS_DIR / "kokoro_vi.pth"
VOICEPACK_PATH = MODELS_DIR / "kokoro_vi_voicepack.pt"
CONFIG_PATH = MODELS_DIR / "config.json"

PORT = int(os.environ.get("PORT", "8081"))
HOST = os.environ.get("HOST", "127.0.0.1")
DEVICE = os.environ.get("DEVICE", "cpu")

# ── App ────────────────────────────────────────────────────────────────
app = FastAPI(title="Kokoro TTS Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model load ─────────────────────────────────────────────────────────
_tts = None
_AVAILABLE_VOICES: list[str] = []
_DEFAULT_VOICE: str = ""

# One model, one style pack per voice. A voicepack is the speaker's style tensor;
# swapping it is what changes the voice, and loading it once per voice keeps the
# model (the expensive part) shared.
_VOICEPACKS: dict[str, object] = {}
_VOICE_LOCK = threading.Lock()


def _voicepack_for(voice: str):
    """The style pack for a voice: the default's loaded pack, a local file, or the repo."""
    if voice == _DEFAULT_VOICE:
        return _tts.voicepack
    if voice in _VOICEPACKS:
        return _VOICEPACKS[voice]

    from kokoro_vietnamese.core import DEFAULT_HF_REPO_ID, resolve_voicepack_filename
    import torch

    filename = resolve_voicepack_filename(voice, None)  # e.g. voicepacks/tuan_ngoc.pt
    local = MODELS_DIR / filename
    if local.exists():
        path = local
    else:
        from huggingface_hub import hf_hub_download

        path = Path(hf_hub_download(repo_id=DEFAULT_HF_REPO_ID, filename=filename))

    pack = torch.load(path, map_location="cpu", weights_only=True)
    _VOICEPACKS[voice] = pack
    print(f"  Voicepack for {voice}: {path}")
    return pack


def _load_model() -> None:
    """Load the Kokoro model and discover available voices."""
    global _tts, _AVAILABLE_VOICES, _DEFAULT_VOICE

    if _tts is not None:
        return

    if not MODEL_PATH.exists():
        raise RuntimeError(f"Model not found: {MODEL_PATH}\nRun: python download_models.py")
    if not VOICEPACK_PATH.exists():
        raise RuntimeError(f"Voicepack not found: {VOICEPACK_PATH}\nRun: python download_models.py")
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Config not found: {CONFIG_PATH}\nRun: python download_models.py")

    from kokoro_vietnamese import KokoroVietnamese, list_voices

    _tts = KokoroVietnamese(
        device=DEVICE,
        model_path=str(MODEL_PATH),
        voicepack_path=str(VOICEPACK_PATH),
        config_path=str(CONFIG_PATH),
    )
    _AVAILABLE_VOICES = list_voices()
    if not _AVAILABLE_VOICES:
        raise RuntimeError("No voices found.")

    # Allow env override, otherwise use first voice
    env_voice = os.environ.get("DEFAULT_VOICE", "").strip()
    if env_voice and env_voice in _AVAILABLE_VOICES:
        _DEFAULT_VOICE = env_voice
    else:
        _DEFAULT_VOICE = _AVAILABLE_VOICES[0]

    print(f"  Loaded model: {MODEL_PATH.name}")
    print(f"  Available voices: {_AVAILABLE_VOICES}")
    print(f"  Default voice: {_DEFAULT_VOICE}")


def get_tts():
    """Return the loaded TTS instance."""
    if _tts is None:
        _load_model()
    return _tts


# ── Schemas ────────────────────────────────────────────────────────────
class SpeechRequest(BaseModel):
    model: str = "tts"
    input: str
    voice: str


# ── Endpoints ──────────────────────────────────────────────────────────

@app.post("/v1/audio/speech")
async def synthesize(req: SpeechRequest) -> Response:
    """
    Synthesize text to speech.

    Returns a WAV audio file (audio/wav).
    """
    text = req.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input text is required")

    tts = get_tts()

    # Pick voice: requested → default → first available
    voice = req.voice.strip() or _DEFAULT_VOICE
    if voice not in _AVAILABLE_VOICES:
        raise HTTPException(
            status_code=400,
            detail=f"Voice '{voice}' not found. Available: {_AVAILABLE_VOICES}",
        )

    # Backticks crash the phonemizer on Windows; replace with single quotes.
    safe_text = text.replace("`", "'")
    try:
        # The model is shared, so the style pack is swapped under a lock: two
        # voices asked for at once must not synthesize each other's speaker.
        with _VOICE_LOCK:
            tts.voicepack = _voicepack_for(voice)
            audio, _phonemes = tts.synthesize(safe_text)
    except Exception as exc:
        traceback.print_exc()
        # A voice whose pack cannot be obtained is refused. The alternative — the
        # default speaker — is the bug this path exists to remove: the caller asks
        # for one voice and hears another with nothing in the response to say so.
        raise HTTPException(
            status_code=503,
            detail=f"Voice '{voice}' could not be used: {exc}",
        ) from exc

    # Write WAV to memory buffer
    buffer = io.BytesIO()
    sf.write(buffer, np.array(audio), 24000, format="WAV")
    buffer.seek(0)

    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={
            "Content-Disposition": 'attachment; filename="speech.wav"',
        },
    )


@app.get("/health")
async def health() -> dict:
    """Health check. Returns ok if model is loaded or loadable."""
    try:
        get_tts()
        return {
            "status": "ok",
            "voices": _AVAILABLE_VOICES,
            "default_voice": _DEFAULT_VOICE,
        }
    except RuntimeError as exc:
        return {"status": "error", "message": str(exc)}


# ── Entry point ────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    print(f"Starting Kokoro TTS Service on http://{HOST}:{PORT}")
    print(f"  Model:      {MODEL_PATH}")
    print(f"  Voicepack:  {VOICEPACK_PATH}")
    print(f"  Config:     {CONFIG_PATH}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

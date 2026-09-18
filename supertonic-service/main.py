#!/usr/bin/env python3
"""Supertonic TSS FastAPI Service."""

import io
import os
import traceback

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

PORT = int(os.environ.get("PORT", "8084"))
HOST = os.environ.get("HOST", "127.0.0.1")

app = FastAPI(title="Supertonic TSS Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_tts = None
_DEFAULT_VOICE = "F1"
_VOICE_STYLES: dict[str, object] = {}
_SAMPLE_RATE = 44100


def _load_model():
    global _tts
    if _tts is not None:
        return
    from supertonic import TTS
    _tts = TTS()
    print("Loaded Supertonic TTS")


def get_tts():
    if _tts is None:
        _load_model()
    return _tts


class SpeechRequest(BaseModel):
    model: str = "tts"
    input: str
    voice: str


@app.post("/v1/audio/speech")
async def synthesize(req: SpeechRequest):
    text = req.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input text is required")
    tts = get_tts()
    requested_voice = req.voice.strip() or _DEFAULT_VOICE

    # Attempt the requested voice; fall back to default if it doesn't exist.
    voice = requested_voice
    try:
        style = _VOICE_STYLES.get(voice)
        if style is None:
            style = tts.get_voice_style(voice)
            _VOICE_STYLES[voice] = style
    except FileNotFoundError:
        print(f"[Supertonic] Voice '{requested_voice}' not found. Falling back to '{_DEFAULT_VOICE}'.")
        voice = _DEFAULT_VOICE
        style = _VOICE_STYLES.get(voice)
        if style is None:
            style = tts.get_voice_style(voice)
            _VOICE_STYLES[voice] = style

    try:
        audio = tts.synthesize(text, voice_style=style)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {exc}")

    if isinstance(audio, np.ndarray):
        samples = audio.astype(np.float32)
    elif isinstance(audio, (list, tuple)) and len(audio) > 0:
        # Supertonic returns (samples_array, sample_rate)
        samples = np.asarray(audio[0], dtype=np.float32)
    else:
        raise HTTPException(status_code=500, detail="Unexpected audio output format")

    # Ensure 1-D: squeeze any leading/trailing singleton dimensions.
    samples = np.squeeze(samples)
    if samples.ndim != 1:
        samples = samples.flatten()
    samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    samples = np.clip(samples, -1.0, 1.0)
    buffer = io.BytesIO()
    sf.write(buffer, samples, _SAMPLE_RATE, format="WAV")
    buffer.seek(0)
    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
    )


@app.get("/health")
async def health():
    try:
        get_tts()
        return {
            "status": "ok",
            "default_voice": _DEFAULT_VOICE,
            "sample_rate": _SAMPLE_RATE,
        }
    except RuntimeError as exc:
        return {"status": "error", "message": str(exc)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

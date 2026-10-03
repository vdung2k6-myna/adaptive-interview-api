#!/usr/bin/env python3
"""Supertonic TSS FastAPI Service."""

import io
import os
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

PORT = int(os.environ.get("PORT", "8084"))
HOST = os.environ.get("HOST", "127.0.0.1")

_tts = None
_DEFAULT_VOICE = "F1"
_SAMPLE_RATE = 44100

# The voices this service can speak in, read from the style directory once at
# startup (see refresh_styles). A name that is not in _HELD_VOICES is refused
# rather than answered in _DEFAULT_VOICE.
_VOICE_STYLES: dict[str, object] = {}
_HELD_VOICES: list[str] = []
_UNREADABLE_VOICES: list[dict[str, str]] = []
_discovered = False


def voice_styles_dir() -> Path:
    """The directory voice styles are read from.

    Resolved through the package's own cache-dir rule so this agrees with what
    ``get_voice_style()`` will later read: ``SUPERTONIC_CACHE_DIR`` when set,
    otherwise the default cache directory for the default model.
    """
    from supertonic import DEFAULT_MODEL
    from supertonic.config import VOICE_STYLES_DIR
    from supertonic.loader import get_cache_dir

    return get_cache_dir(DEFAULT_MODEL) / VOICE_STYLES_DIR


def discover_styles() -> tuple[list[str], list[dict[str, str]]]:
    """Read every style file in the style directory.

    Returns the names that loaded and, separately, the files that did not, each
    with the reason. Loading a style reads one JSON file through the package's
    own parser — it does not load the model or any ONNX weights.
    """
    from supertonic.loader import load_voice_style_from_json_file

    directory = voice_styles_dir()
    if not directory.is_dir():
        return [], [{"path": str(directory), "reason": "voice styles directory not found"}]

    held: list[str] = []
    unreadable: list[dict[str, str]] = []
    for path in sorted(directory.glob("*.json")):
        try:
            load_voice_style_from_json_file(path)
        except Exception as exc:
            unreadable.append({"path": str(path), "reason": f"{type(exc).__name__}: {exc}"})
        else:
            held.append(path.stem)
    return held, unreadable


def refresh_styles() -> None:
    """Re-read the style directory into module state and report the result.

    A style file that cannot be read is reported and reflected in /health, but
    it does not stop the service: the styles that did load are still served.
    """
    global _HELD_VOICES, _UNREADABLE_VOICES, _discovered

    try:
        held, unreadable = discover_styles()
    except Exception as exc:
        held = []
        unreadable = [{"path": str(voice_styles_dir()), "reason": f"{type(exc).__name__}: {exc}"}]

    _HELD_VOICES = held
    _UNREADABLE_VOICES = unreadable
    _VOICE_STYLES.clear()
    _discovered = True

    print(
        f"[Supertonic] {len(held)} voice styles available: {', '.join(held) or 'none'}",
        flush=True,
    )
    for problem in unreadable:
        print(
            f"[Supertonic] Unreadable voice style: {problem['path']} ({problem['reason']})",
            flush=True,
        )


def ensure_styles() -> None:
    """Read the style directory if startup has not already done so."""
    if not _discovered:
        refresh_styles()


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
    voice: str = ""


@asynccontextmanager
async def lifespan(_app: FastAPI):
    refresh_styles()
    yield


app = FastAPI(title="Supertonic TSS Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/v1/audio/speech")
async def synthesize(req: SpeechRequest):
    text = req.input.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input text is required")

    ensure_styles()
    requested_voice = req.voice.strip()
    if not requested_voice:
        # Names nothing — the deployment's default is the right answer.
        voice = _DEFAULT_VOICE
    elif requested_voice in _HELD_VOICES:
        voice = requested_voice
    else:
        # Names something the service does not hold. Refuse; never substitute.
        raise HTTPException(
            status_code=400,
            detail=(
                f"Voice '{requested_voice}' is not available. "
                f"Available voices: {', '.join(_HELD_VOICES) or 'none'}"
            ),
        )

    tts = get_tts()

    style = _VOICE_STYLES.get(voice)
    if style is None:
        try:
            style = tts.get_voice_style(voice)
        except FileNotFoundError:
            # Held at startup but gone from disk since — same refusal.
            raise HTTPException(
                status_code=400,
                detail=f"Voice '{voice}' is not available. Its style file is missing.",
            )
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
    except RuntimeError as exc:
        return {"status": "error", "message": str(exc)}
    ensure_styles()
    return {
        "status": "degraded" if _UNREADABLE_VOICES else "ok",
        "default_voice": _DEFAULT_VOICE,
        "sample_rate": _SAMPLE_RATE,
        # Read from startup state, not a rescan: which voices are loaded is a
        # fact about the process, and a deployment reads it back here.
        "voices": list(_HELD_VOICES),
        "unreadable_voices": [problem["path"] for problem in _UNREADABLE_VOICES],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

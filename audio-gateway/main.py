#!/usr/bin/env python3
"""
Audio Gateway (Unified TTS)

Provides a single HTTP endpoint for text-to-speech synthesis.
Internally routes to Kokoro, Piper, or Supertonic based on the `engine` parameter.

Endpoints:
  POST /v1/audio/speech    - Synthesize text to WAV audio
  GET  /health             - Health check (aggregates downstream services)
"""

import io
import os
import sys
import traceback
import wave
from array import array

import httpx
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Configuration ──────────────────────────────────────────────────────
KOKORO_URL = os.environ.get("KOKORO_URL", "http://localhost:8081")
PIPER_URL = os.environ.get("PIPER_URL", "http://localhost:8083")
SUPERTONIC_URL = os.environ.get("SUPERTONIC_URL", "http://localhost:8084")
PORT = int(os.environ.get("PORT", "8082"))
HOST = os.environ.get("HOST", "127.0.0.1")

# The engines this gateway serves. A request names one in `model` (OpenAI's
# field) or in `engine` (the legacy spelling); anything else is refused rather
# than folded into a default, because the wrong engine is a different voice.
ENGINES = ("kokoro", "piper", "supertonic")


def _gain(name: str, fallback: float) -> float:
    """Read a linear multiplier, falling back when it is absent or unusable.

    The value levels one engine against another; a nought or a negative would
    silence the room rather than balance it, so both read as the fallback.
    """
    raw = os.environ.get(name, "").strip()
    if raw == "":
        return fallback
    try:
        value = float(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


# Measured against the same Vietnamese sentence: kokoro and piper come back at
# full scale while supertonic sits about 8 dB below them. The gateway applies
# these because it is where the engine is known and where every caller's audio
# passes; a profile therefore names no level of its own.
ENGINE_GAIN = {
    "kokoro": _gain("KOKORO_VOLUME", 0.5),
    "piper": _gain("PIPER_VOLUME", 0.7),
    "supertonic": _gain("SUPERTONIC_VOLUME", 1.2),
}

# ── App ────────────────────────────────────────────────────────────────
app = FastAPI(title="Audio Gateway", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── HTTP client ──────────────────────────────────────────────────────────
_http_client: httpx.AsyncClient | None = None


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=60.0)
    return _http_client


# ── Request model ──────────────────────────────────────────────────────
class SynthesizeRequest(BaseModel):
    """OpenAI's speech contract, with the fields this gateway had before it.

    `input` is the text and `model` names the engine; `text` and `engine` are the
    legacy spellings, kept so a caller that has not moved yet keeps working. The
    handler resolves both and refuses a value that names no engine it serves.
    """

    input: str | None = None
    text: str | None = None
    voice: str
    model: str | None = None
    engine: str | None = None
    response_format: str | None = None

    def spoken_text(self) -> str:
        return self.input if self.input is not None else (self.text or "")

    def resolved_engine(self) -> str:
        if self.model in ENGINES:
            return self.model
        if self.engine in ENGINES:
            return self.engine
        if self.engine is not None:
            raise HTTPException(status_code=400, detail=f"Unknown engine: {self.engine}")
        if self.model is not None:
            raise HTTPException(status_code=400, detail=f"Unknown model: {self.model}")
        return "kokoro"


# ── Helpers ────────────────────────────────────────────────────────────
async def _check_service(url: str) -> bool:
    """Quick health check against a downstream service."""
    try:
        client = await _get_client()
        res = await client.get(f"{url}/health", timeout=5.0)
        return res.status_code == 200
    except Exception:
        return False


async def _supertonic_status() -> tuple[bool, list[str] | None]:
    """Reach the Supertonic service once, for both its liveness and its voices.

    That service's /health names the style files it holds. Relaying the list
    lets a caller check its configured voice names against what is actually
    loaded without needing an address for the synthesis service itself.

    Returns the liveness flag and, when it answered, the voices it named — or
    None when it was unreachable or did not name any.
    """
    try:
        client = await _get_client()
        res = await client.get(f"{SUPERTONIC_URL}/health", timeout=5.0)
    except Exception:
        return False, None

    if res.status_code != 200:
        return False, None

    # It answered, so it is alive. A body this cannot read costs the voice list,
    # not the liveness — reporting a live service as down would be the worse lie.
    try:
        voices = res.json().get("voices")
    except Exception:
        return True, None

    if not isinstance(voices, list):
        return True, None
    return True, [voice for voice in voices if isinstance(voice, str)]


def _levelled(wav_bytes: bytes, engine: str) -> bytes:
    """Apply the engine's own volume to a WAV answer, and report clipping.

    A sample that clamps is distortion, not a volume that worked, so it is
    counted and logged rather than passed on in silence. An answer this cannot
    read as 16-bit PCM is returned unchanged: the caller's own format check is
    the place that refuses it, not a level this module could invent.
    """
    gain = ENGINE_GAIN[engine]
    if gain == 1.0:
        return wav_bytes
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as src:
            params = src.getparams()
            frames = src.readframes(params.nframes)
    except (wave.Error, EOFError):
        return wav_bytes
    if params.sampwidth != 2:
        return wav_bytes
    samples = array("h")
    samples.frombytes(frames)
    if samples.itemsize != 2:
        return wav_bytes
    if sys.byteorder == "big":
        samples.byteswap()
    clipped = 0
    for index, sample in enumerate(samples):
        scaled = int(round(sample * gain))
        if scaled > 32767:
            scaled = 32767
            clipped += 1
        elif scaled < -32768:
            scaled = -32768
            clipped += 1
        samples[index] = scaled
    if sys.byteorder == "big":
        samples.byteswap()
    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setparams(params)
        dst.writeframes(samples.tobytes())
    if clipped:
        share = 100 * clipped / len(samples)
        print(
            f"[AudioGateway] volume {gain} for {engine} clipped "
            f"{clipped}/{len(samples)} samples ({share:.2f}%); "
            f"lower {engine.upper()}_VOLUME to stop distorting"
        )
    return out.getvalue()


async def _proxy_to_kokoro(req: SynthesizeRequest) -> bytes:
    """Forward request to Kokoro TTS service.

    Kokoro expects: { input: string, voice?: string, model?: string }
    """
    client = await _get_client()

    # `model` names the engine, not the leaf service's own model, so it is not
    # forwarded: a leaf told `model: "kokoro"` would be asked for something that
    # is not a model at all.
    payload: dict[str, str] = {
        "input": req.spoken_text(),
        "voice": req.voice,
    }

    try:
        res = await client.post(
            f"{KOKORO_URL}/v1/audio/speech",
            json=payload,
            timeout=60.0,
        )
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=502, detail=f"Cannot connect to Kokoro: {exc}")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Kokoro TTS timed out")

    if res.status_code >= 400:
        detail = res.text or f"Kokoro returned {res.status_code}"
        raise HTTPException(status_code=502, detail=detail)

    return res.content


async def _proxy_to_piper(req: SynthesizeRequest) -> bytes:
    """Forward request to Piper TTS service."""
    client = await _get_client()

    payload = {
        "text": req.spoken_text(),
        "voice": req.voice,
    }
    # Piper doesn't use 'model' param; voice ID selects the model

    try:
        res = await client.post(
            f"{PIPER_URL}/v1/audio/speech",
            json=payload,
            timeout=60.0,
        )
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=502, detail=f"Cannot connect to Piper: {exc}")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Piper TTS timed out")

    if res.status_code >= 400:
        detail = res.text or f"Piper returned {res.status_code}"
        raise HTTPException(status_code=502, detail=detail)

    return res.content


async def _proxy_to_supertonic(req: SynthesizeRequest) -> bytes:
    """Forward request to Supertonic TTS service.

    Supertonic expects: { input: string, voice?: string, model?: string }
    (same shape as Kokoro, so this mirrors _proxy_to_kokoro).
    """
    client = await _get_client()

    # As with Kokoro: `model` names the engine and is not the service's model.
    payload: dict[str, str] = {
        "input": req.spoken_text(),
        "voice": req.voice,
    }

    try:
        res = await client.post(
            f"{SUPERTONIC_URL}/v1/audio/speech",
            json=payload,
            timeout=60.0,
        )
    except httpx.ConnectError as exc:
        raise HTTPException(status_code=502, detail=f"Cannot connect to Supertonic: {exc}")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Supertonic TTS timed out")

    if res.status_code >= 400:
        detail = res.text or f"Supertonic returned {res.status_code}"
        raise HTTPException(status_code=502, detail=detail)

    return res.content


# ── Endpoints ──────────────────────────────────────────────────────────
@app.post("/v1/audio/speech")
async def synthesize(req: SynthesizeRequest) -> Response:
    """Synthesize text to speech via the engine named in `model` or `engine`."""
    if not req.spoken_text().strip():
        raise HTTPException(status_code=400, detail="input is required")

    # WAV is what every caller reads; asking for another format is asking this
    # gateway for something it does not produce, so it is refused rather than
    # answered with WAV under another label.
    if req.response_format not in (None, "", "wav"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported response_format: {req.response_format}",
        )

    engine = req.resolved_engine()
    if engine == "kokoro":
        audio = await _proxy_to_kokoro(req)
    elif engine == "piper":
        audio = await _proxy_to_piper(req)
    else:
        audio = await _proxy_to_supertonic(req)

    return Response(content=_levelled(audio, engine), media_type="audio/wav")


@app.get("/health")
async def health() -> dict:
    """Aggregated health check across all TTS services.

    Carries the Supertonic service's voice list through when it answers, so a
    caller can read the loaded voices from the gateway it already talks to. The
    list is absent, not empty, when that service could not be reached — an
    unreachable service says nothing about which voices are installed.
    """
    kokoro_ok = await _check_service(KOKORO_URL)
    piper_ok = await _check_service(PIPER_URL)
    supertonic_ok, voices = await _supertonic_status()

    all_ok = kokoro_ok and piper_ok and supertonic_ok
    status = "ok" if all_ok else ("degraded" if (kokoro_ok or piper_ok or supertonic_ok) else "down")

    payload = {
        "status": status,
        "gateway": True,
        "kokoro": kokoro_ok,
        "piper": piper_ok,
        "supertonic": supertonic_ok,
    }
    if voices is not None:
        payload["voices"] = voices
    return payload


# ── Entrypoint ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)

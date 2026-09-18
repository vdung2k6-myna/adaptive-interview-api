#!/usr/bin/env python3
"""
Audio Gateway (Unified TTS)

Provides a single HTTP endpoint for text-to-speech synthesis.
Internally routes to Kokoro, Piper, or Supertonic based on the `engine` parameter.

Endpoints:
  POST /v1/audio/speech    - Synthesize text to WAV audio
  GET  /health             - Health check (aggregates downstream services)
"""

import os
import traceback
from typing import Literal

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
    text: str
    engine: Literal["kokoro", "piper", "supertonic"] = "kokoro"
    voice: str
    model: str | None = None


# ── Helpers ────────────────────────────────────────────────────────────
async def _check_service(url: str) -> bool:
    """Quick health check against a downstream service."""
    try:
        client = await _get_client()
        res = await client.get(f"{url}/health", timeout=5.0)
        return res.status_code == 200
    except Exception:
        return False


async def _proxy_to_kokoro(req: SynthesizeRequest) -> Response:
    """Forward request to Kokoro TTS service.

    Kokoro expects: { input: string, voice?: string, model?: string }
    """
    client = await _get_client()

    payload: dict[str, str] = {
        "input": req.text,
        "voice": req.voice,
    }
    if req.model:
        payload["model"] = req.model

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

    return Response(content=res.content, media_type="audio/wav")


async def _proxy_to_piper(req: SynthesizeRequest) -> Response:
    """Forward request to Piper TTS service."""
    client = await _get_client()

    payload = {
        "text": req.text,
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

    return Response(content=res.content, media_type="audio/wav")


async def _proxy_to_supertonic(req: SynthesizeRequest) -> Response:
    """Forward request to Supertonic TTS service.

    Supertonic expects: { input: string, voice?: string, model?: string }
    (same shape as Kokoro, so this mirrors _proxy_to_kokoro).
    """
    client = await _get_client()

    payload: dict[str, str] = {
        "input": req.text,
        "voice": req.voice,
    }
    if req.model:
        payload["model"] = req.model

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

    return Response(content=res.content, media_type="audio/wav")


# ── Endpoints ──────────────────────────────────────────────────────────
@app.post("/v1/audio/speech")
async def synthesize(req: SynthesizeRequest) -> Response:
    """Synthesize text to speech via the selected engine."""
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    if req.engine == "kokoro":
        return await _proxy_to_kokoro(req)
    elif req.engine == "piper":
        return await _proxy_to_piper(req)
    elif req.engine == "supertonic":
        return await _proxy_to_supertonic(req)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown engine: {req.engine}")


@app.get("/health")
async def health() -> dict:
    """Aggregated health check across all TTS services."""
    kokoro_ok = await _check_service(KOKORO_URL)
    piper_ok = await _check_service(PIPER_URL)
    supertonic_ok = await _check_service(SUPERTONIC_URL)

    all_ok = kokoro_ok and piper_ok and supertonic_ok
    status = "ok" if all_ok else ("degraded" if (kokoro_ok or piper_ok or supertonic_ok) else "down")

    return {
        "status": status,
        "gateway": True,
        "kokoro": kokoro_ok,
        "piper": piper_ok,
        "supertonic": supertonic_ok,
    }


# ── Entrypoint ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)

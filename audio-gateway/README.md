# Audio Gateway (Unified TTS)

A lightweight HTTP gateway that exposes a single TTS endpoint and routes to **Kokoro**, **Piper**, or **Supertonic** based on the `engine` parameter.

## Why This Exists

Instead of the backend talking directly to multiple TTS services, it talks to **one** gateway. The gateway handles routing, health checks, and pass-through proxying. It does not choose a voice: the `voice` it is given is forwarded unchanged, and each downstream service decides what to do with a name it does not hold.

```
Express Backend (:4000)
    │ POST /v1/audio/speech { text, engine, voice }
    ▼
Audio Gateway (:8082)
    ├─ engine=kokoro     ──▶ Kokoro Service (:8081)
    ├─ engine=piper      ──▶ Piper Service (:8083)
    └─ engine=supertonic ──▶ Supertonic Service (:8084)
```

## Setup

```bash
cd audio-gateway
pip install -r requirements.txt
```

## Run

```bash
# Set downstream URLs (optional — defaults shown)
export KOKORO_URL="http://localhost:8081"
export PIPER_URL="http://localhost:8083"
export SUPERTONIC_URL="http://localhost:8084"
export PORT=8082

python main.py
# or
uvicorn main:app --host 127.0.0.1 --port 8082
```

## API

### POST /v1/audio/speech

**Request:**
```json
{
  "text": "Xin chào, bạn khỏe không?",
  "engine": "piper",
  "voice": "vi_VN-vais1000-medium"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to synthesize |
| `engine` | `"kokoro"` \| `"piper"` \| `"supertonic"` | No | Default: `"kokoro"` |
| `voice` | string | Yes | Voice ID, forwarded to the downstream service unchanged |
| `model` | string | No | Model override, forwarded to Kokoro and Supertonic. Piper ignores it |

**Response:** `audio/wav` — WAV file bytes.

**Errors:**
- `400` — `text` missing or whitespace-only
- `422` — Body failed validation: `voice` absent, or `engine` outside the enum. The `Literal` rejects an unknown engine during parsing, so this is what an unknown engine returns — the `400 "Unknown engine"` branch in the handler is unreachable from JSON
- `502` — Downstream refused the request (status ≥ 400) or could not be reached
- `504` — Downstream timed out (60s)

### GET /health

```json
{
  "status": "ok",
  "gateway": true,
  "kokoro": true,
  "piper": true,
  "supertonic": true,
  "voices": ["F1", "M1"]
}
```

`status` values: `"ok"` (all up), `"degraded"` (some up), `"down"` (none up).

`voices` is relayed from the Supertonic service's own `/health`, so a caller can check its configured voice names against what is actually installed. The key is **absent**, not empty, when that service could not be reached.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KOKORO_URL` | `http://localhost:8081` | Kokoro service base URL |
| `PIPER_URL` | `http://localhost:8083` | Piper service base URL |
| `SUPERTONIC_URL` | `http://localhost:8084` | Supertonic service base URL |
| `PORT` | `8082` | Gateway HTTP port |
| `HOST` | `127.0.0.1` | Gateway HTTP host |

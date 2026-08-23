# Audio Gateway (Unified TTS)

A lightweight HTTP gateway that exposes a single TTS endpoint and routes to either **Kokoro** or **Piper** based on the `engine` parameter.

## Why This Exists

Instead of Next.js talking directly to multiple TTS services, it talks to **one** gateway. The gateway handles routing, health checks, and pass-through proxying.

```
Next.js App (:3000)
    │ POST /v1/audio/speech { text, engine, voice }
    ▼
Audio Gateway (:8082)
    ├─ engine=kokoro ──▶ Kokoro Service (:8081)
    └─ engine=piper  ──▶ Piper Service (:8083)
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
| `engine` | `"kokoro"` \| `"piper"` | No | Default: `"kokoro"` |
| `voice` | string | No | Voice ID (passed through to downstream) |
| `model` | string | No | Model override (Kokoro only) |

**Response:** `audio/wav` — WAV file bytes.

**Errors:**
- `400` — Missing text or unknown engine
- `502` — Downstream TTS service error or unreachable
- `504` — Downstream TTS timeout

### GET /health

```json
{
  "status": "ok",
  "gateway": true,
  "kokoro": true,
  "piper": true
}
```

`status` values: `"ok"` (all up), `"degraded"` (some up), `"down"` (none up).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KOKORO_URL` | `http://localhost:8081` | Kokoro service base URL |
| `PIPER_URL` | `http://localhost:8083` | Piper service base URL |
| `PORT` | `8082` | Gateway HTTP port |
| `HOST` | `127.0.0.1` | Gateway HTTP host |

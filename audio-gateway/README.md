# Audio Gateway (Unified TTS)

A lightweight HTTP gateway that exposes the OpenAI speech contract and routes to
**Kokoro**, **Piper**, or **Supertonic**, named in `model`.

## Why This Exists

Instead of the backend talking directly to multiple TTS services, it talks to **one**
gateway. The gateway routes by `model`, health-checks the services, forwards the
`voice` unchanged, and levels the engines against each other. One speech contract is
what lets every provider — the local engines here and a hosted endpoint a profile
names — be configured the same way.

```
Express Backend (:4000)
    │ POST /v1/audio/speech { model, input, voice, response_format }
    ▼
Audio Gateway (:8082)
    ├─ model=kokoro     ──▶ Kokoro Service (:8081)
    ├─ model=piper      ──▶ Piper Service (:8083)
    ├─ model=supertonic ──▶ Supertonic Service (:8084)
    └─ anything else    ──▶ 400, naming the value
```

`text` and `engine` are the gateway's own older spellings and are still accepted, so
a caller that has not moved yet keeps working. `model` and `input` win when both are
present.

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
  "model": "piper",
  "input": "Xin chào, bạn khỏe không?",
  "voice": "vi_VN-vais1000-medium",
  "response_format": "wav"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | string | Yes¹ | Text to synthesize (OpenAI's field) |
| `text` | string | Yes¹ | Legacy alias for `input` |
| `model` | `"kokoro"` \| `"piper"` \| `"supertonic"` | Yes² | The engine to route to |
| `engine` | same as `model` | Yes² | Legacy alias for `model` |
| `voice` | string | Yes | Voice ID, forwarded to the downstream service unchanged |
| `response_format` | `"wav"` | No | Default: `"wav"`. Any other value is refused |

¹ One of `input` or `text` is required.
² One of `model` or `engine` is required; neither present defaults to `kokoro`.

**Response:** `audio/wav` — WAV file bytes, levelled by that engine's volume.

**Errors:**
- `400` — no text, an unknown `model`/`engine`, or a `response_format` other than `wav`
- `422` — body failed validation, most often a missing `voice`
- `502` — downstream refused the request (status ≥ 400) or could not be reached
- `504` — downstream timed out (60s)

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

`voices` is relayed from the Supertonic service's own `/health`, so a caller can
check its configured voice names against what is actually installed. The key is
**absent**, not empty, when that service could not be reached.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KOKORO_URL` | `http://localhost:8081` | Kokoro service base URL |
| `PIPER_URL` | `http://localhost:8083` | Piper service base URL |
| `SUPERTONIC_URL` | `http://localhost:8084` | Supertonic service base URL |
| `PORT` | `8082` | Gateway HTTP port |
| `HOST` | `127.0.0.1` | Gateway HTTP host |
| `KOKORO_VOLUME` | `0.5` | Linear level for Kokoro |
| `PIPER_VOLUME` | `0.7` | Linear level for Piper |
| `SUPERTONIC_VOLUME` | `1.2` | Linear level for Supertonic |

The levels are here because the gateway is where the engine is known and where every
caller's audio passes. The engines do not agree on loudness — kokoro and piper arrive
at full scale and supertonic about 8 dB below — so each is matched here rather than by
each caller. A value above what an engine's headroom allows is clamped, and the share
of clipped samples is logged.

## Tests

```bash
cd audio-gateway
python -m pytest tests -q
```

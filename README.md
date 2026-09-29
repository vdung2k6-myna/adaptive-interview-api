# Adaptive Interview API

Standalone backend API for the [Adaptive Interview Engine](https://github.com/vdung2k6-myna/adaptive-interview).

Extracted from the Next.js monolith as part of Pattern B separation.

## Quick Links

- [Setup Guide](docs/SETUP.md)
- [API Reference](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Database Guide](docs/DATABASE.md)
- [Evaluation System](docs/EVALUATION.md)
- [Ollama Integration](docs/OLLAMA.md)
- [Performance Notes](docs/PERFORMANCE.md)
- [Frontend repo](https://github.com/vdung2k6-myna/adaptive-interview)

## Route Overview

```
Express Server (:4000)
├── /api/candidates      → CRUD candidates
├── /api/positions       → CRUD positions
├── /api/sessions        → Interview sessions
├── /api/campaigns       → Recruiting campaigns
├── /api/messages        → Streaming chat with Ollama
├── /api/evaluations     → AI scoring + calibration
├── /api/voice           → Voice interview pipeline
├── /api/voice-agent     → Ephemeral voice agent chat (prefetch + material replies)
├── /api/personas        → Persona catalog (read-only, seeded)
├── /api/mcp             → MCP analytics SSE
└── /audio               → Static audio file serving
```

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with DATABASE_URL, OLLAMA_BASE_URL, and optional tokens
npx drizzle-kit migrate
npm run dev
```

Then verify:

```bash
curl http://localhost:4000/health
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `4000`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `OLLAMA_BASE_URL` | Yes | Ollama API URL |
| `OLLAMA_MODEL` | No | Chat model (default: `llama3.1`) |
| `OLLAMA_EMBED_MODEL` | No | Embedding model (default: `mxbai-embed-large`) |
| `API_AUTH_TOKEN` | No | Enables Bearer token auth when set |
| `MCP_ENABLED` | No | Enables `/api/mcp` when set to `true` |
| `MCP_AUTH_TOKEN` | No | MCP auth token (required when MCP is enabled) |
| `FRONTEND_URL` | No | CORS origin (default: `http://localhost:3000`) |
| `AUDIO_STORAGE_DIR` | No | Audio file storage path (default: `/tmp/audio`) |
| `AUDIOCPP_BASE_URL` | No | audio.cpp STT server URL |
| `AUDIO_GATEWAY_URL` | No | Audio Gateway TTS server URL |
| `DEFAULT_TTS_ENGINE` | No | `kokoro`, `piper`, or `supertonic` (default: `kokoro`) |
| `DEFAULT_VOICE` | No | Voice ID (default: `default_voice`) |
| `EMBEDDING_SIMILARITY_THRESHOLD` | No | Default: `0.75` |
| `KOKORO_VOICE_ENGLISH` | No | Kokoro voice for English sessions (e.g. `af_heart`) |
| `KOKORO_VOICE_VIETNAMESE` | No | Kokoro voice for Vietnamese sessions |
| `PIPER_VOICE_ENGLISH` | No | Piper voice for English sessions (e.g. `en_US-lessac-medium`) |
| `PIPER_VOICE_VIETNAMESE` | No | Piper voice for Vietnamese sessions |
| `SUPERTONIC_VOICE_ENGLISH` | No | Supertonic voice for English sessions (default: `default`) |
| `SUPERTONIC_VOICE_VIETNAMESE` | No | Supertonic voice for Vietnamese sessions |
| `MATERIAL_COLLECTIONS` | No | Collections whose stored text may be spoken verbatim by a material reply. **Unset means the empty set, and an empty set means every reply is generated** — see [Material replies](docs/API.md#material-replies) |
| `MATERIAL_SCORE_FLOOR` | No | Minimum hit score, in `[0, 1]`, for a hit to be spoken (default: `0.55`). Read only when `MATERIAL_COLLECTIONS` names something |

### Material replies

A voice-agent turn can be answered from the indexed material instead of by the
language model: the search locates one result, expanded to its whole section, and
that section's stored text is the reply. It is off by default and stays off until
a deployment opts in, because it speaks stored text verbatim:

```bash
# Speak the stored text of a hit in these collections, at or above 0.55
MATERIAL_COLLECTIONS=truyen-kiem-hiep,kiem-hiep
MATERIAL_SCORE_FLOOR=0.55
```

A request asks for it per turn (`answerMode: "material"`), and only a turn that
also lands a hit in a named collection at or above the floor is answered that
way — every other turn generates exactly as it always has. The floor's default is
measured, and re-measuring it is a task after a corpus or embedding-model change:

```bash
node scripts/measure-material-floor.mjs   # doc-etl-api must be up
```

It asks the same `top_k: 1` question a material turn's locator asks, for 8
queries naming a story, 8 asking vaguely and 8 plainly off-topic, and writes the
scores to `D:/tmp/material-floor.json`. On the development corpus (23 Sep 2026)
those bands measured **0.635–0.677 / 0.480–0.596 / 0.380–0.531**: the named and
off-topic bands do not overlap, so any floor in `(0.531, 0.635]` separates them,
and the `0.55` default refuses none of the 8 named queries, 3 of the 8 vague ones
and none of the 8 off-topic ones. See [docs/API.md](docs/API.md#material-replies).

The passage a material turn speaks arrives with the locator search that found it, so
a client that prefetches while the user types can send `answerMode: "material"` on
that prefetch (`POST /api/voice-agent/prefetch`) to have the hold carry it. Omitting
it is valid: the turn then declines the hold and issues the locator search it would
have issued with no prefetch held — one search it would otherwise have skipped, and
never a worse reply.

## Testing with curl

```bash
# Health check (no auth)
curl http://localhost:4000/health

# Set your API token if API_AUTH_TOKEN is configured
export API_KEY=your-secret-token-here

# List candidates
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/api/candidates

# Create candidate
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","skills":["TS"],"experienceYears":3,"cv":"Backend dev"}' \
  http://localhost:4000/api/candidates

# List positions
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/api/positions

# Create session
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"positionId":"...","candidateId":"...","mode":"text","maxTurns":5}' \
  http://localhost:4000/api/sessions

# Start interview (generate first question)
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"sessionId":"..."}' \
  http://localhost:4000/api/messages

# Voice start
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"sessionId":"..."}' \
  http://localhost:4000/api/voice/start

# TTS synthesis
curl -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Hello world"}' \
  http://localhost:4000/api/voice/speak --output test.wav
```

## Audio Services (for Voice Interviews)

Voice interviews require an audio stack with three services plus an external STT binary.

| Service | Port | Directory | Purpose |
|---------|------|-----------|---------|
| **audio.cpp** | 8080 | External | Speech-to-text (STT) transcription |
| **Kokoro** | 8081 | `kokoro-service/` | Text-to-speech (TTS) — fast, high quality |
| **Piper** | 8083 | `piper-service/` | Text-to-speech (TTS) — multiple voices |
| **Supertonic** | 8084 | `supertonic-service/` | Text-to-speech (TTS) — open-source, 31 languages, 44.1kHz |
| **Audio Gateway** | 8082 | `audio-gateway/` | Unified TTS proxy — routes to Kokoro, Piper, or Supertonic |

```bash
# Start all audio services
npm run start:audio

# Stop all audio services
npm run stop:audio
```

See [docs/SETUP.md](docs/SETUP.md) and the per-service READMEs for detailed setup.

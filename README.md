# Adaptive Interview API

Standalone backend API for the [Adaptive Interview Engine](../ollama-chat-react).

Extracted from the Next.js monolith as part of Pattern B separation.

## Quick Links

- [Setup Guide](docs/SETUP.md)
- [API Reference](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Frontend repo](../ollama-chat-react)

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
| `DEFAULT_TTS_ENGINE` | No | `kokoro` or `piper` (default: `kokoro`) |
| `DEFAULT_VOICE` | No | Voice ID (default: `default_voice`) |
| `EMBEDDING_SIMILARITY_THRESHOLD` | No | Default: `0.75` |

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
| **Audio Gateway** | 8082 | `audio-gateway/` | Unified TTS proxy — routes to Kokoro or Piper |

```bash
# Start all audio services
npm run start:audio

# Stop all audio services
npm run stop:audio
```

See [docs/SETUP.md](docs/SETUP.md) and the per-service READMEs for detailed setup.

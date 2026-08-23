# Adaptive Interview API

Standalone backend API for the Adaptive Interview Engine.

Extracted from the Next.js monolith as part of Pattern B separation.

## Architecture

```
Express Server (:4000)
├── /api/candidates      → CRUD candidates
├── /api/positions       → CRUD positions
├── /api/sessions        → Interview sessions
├── /api/campaigns       → Recruiting campaigns
├── /api/messages        → Streaming chat with Ollama
├── /api/evaluations     → AI scoring
├── /api/voice           → Voice interview pipeline
├── /api/mcp             → MCP analytics SSE
└── /audio               → Static audio file serving
```

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your DATABASE_URL, OLLAMA_BASE_URL, API_AUTH_TOKEN
npx drizzle-kit migrate
npm run dev
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 4000) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `OLLAMA_BASE_URL` | Yes | Ollama API URL |
| `API_AUTH_TOKEN` | Yes | Bearer token for API auth |
| `MCP_AUTH_TOKEN` | Yes | MCP auth token |
| `FRONTEND_URL` | No | CORS origin (default: http://localhost:3000) |
| `AUDIO_STORAGE_DIR` | No | Audio file storage path |
| `AUDIOCPP_BASE_URL` | No | audio.cpp STT server URL |
| `AUDIO_GATEWAY_URL` | No | Audio Gateway TTS server URL |
| `DEFAULT_TTS_ENGINE` | No | `kokoro` or `piper` |
| `DEFAULT_VOICE` | No | Voice ID (e.g. `default_name`) |

## Testing with curl

```bash
# Health check (no auth)
curl http://localhost:4000/health

# Set your API token
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
  -d '{"sessionId":"...","action":"start"}' \
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

### Setup

```bash
# Kokoro — create venv and install dependencies
cd kokoro-service
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python download_models.py

# Piper — create venv and install dependencies
cd ../piper-service
python -m venv .venv
# Activate as above
pip install -r requirements.txt

# Audio Gateway — create venv and install dependencies
cd ../audio-gateway
python -m venv .venv
# Activate as above
pip install -r requirements.txt
```

### Running

```bash
# Start all audio services
npm run start:audio

# Stop all audio services
npm run stop:audio
```

Or run the platform-specific scripts directly:

```bash
# Windows
.\scripts\start-audio-services.bat
.\scripts\stop-audio-services.bat

# Linux/macOS
./scripts/start-audio-services.sh
./scripts/stop-audio-services.sh
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIOCPP_BASE_URL` | `http://localhost:8080` | audio.cpp STT server URL |
| `AUDIO_GATEWAY_URL` | `http://localhost:8082` | Audio Gateway TTS proxy URL |
| `DEFAULT_TTS_ENGINE` | `kokoro` | Default TTS engine (`kokoro` or `piper`) |
| `DEFAULT_VOICE` | `default_name` | Default voice ID |

### Model Files

- **Piper models** live in `pipervoices/` (auto-discovered on startup).
- **Kokoro models** live in `kokoro-service/models/` (run `download_models.py` to fetch).

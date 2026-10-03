# Backend Setup Guide

This guide covers setting up the standalone Express backend (`adaptive-interview-api`) for the Adaptive Interview Engine.

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **PostgreSQL** 15+ with `pgvector` extension
- **Ollama** (local or remote)
- **npm** or **yarn**

## 1. Clone and Install

```bash
git clone <backend-repo-url> adaptive-interview-api
cd adaptive-interview-api
npm install
```

## 2. Configure Environment

Copy the example file and edit `.env`:

```bash
cp .env.example .env
```

Required variables:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/ai_interview

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
OLLAMA_EMBED_MODEL=mxbai-embed-large
```

Optional variables:

```bash
# API authentication (enables Bearer token when set)
API_AUTH_TOKEN=your-secret-api-token

# MCP analytics server
MCP_ENABLED=true
MCP_AUTH_TOKEN=your-mcp-secret

# Voice interview audio services
AUDIO_STORAGE_DIR=/tmp/audio
AUDIOCPP_BASE_URL=http://localhost:8080
AUDIO_GATEWAY_URL=http://localhost:8082
DEFAULT_TTS_ENGINE=kokoro
DEFAULT_VOICE=af_heart

# Per-language TTS voices (English defaults; leave Vietnamese empty to use service defaults)
KOKORO_VOICE_ENGLISH=af_heart
# KOKORO_VOICE_VIETNAMESE=
PIPER_VOICE_ENGLISH=en_US-lessac-medium
# PIPER_VOICE_VIETNAMESE=

# CORS
FRONTEND_URL=http://localhost:3000

# Server
PORT=4000
```

## 3. Set Up PostgreSQL

### Install PostgreSQL and pgvector

**macOS (Homebrew):**

```bash
brew install postgresql@15
brew install pgvector
```

**Ubuntu/Debian:**

```bash
sudo apt-get install postgresql-15
sudo apt-get install postgresql-15-pgvector
```

**Windows:**

Download and install PostgreSQL 15+ from the official installer. The `pgvector` extension may need manual installation.

### Create Database

```bash
createdb ai_interview
```

### Enable pgvector Extension

```bash
psql ai_interview -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## 4. Run Database Migrations

```bash
npx drizzle-kit migrate
```

Or apply migration files manually:

```bash
psql $DATABASE_URL -f migrations/0000_initial.sql
# Apply subsequent migrations as needed
```

**If you take the manual path, baseline the bookkeeping afterwards.** `drizzle-kit
migrate` decides what to apply from `drizzle.__drizzle_migrations` alone, and
applying SQL by hand writes no rows there — so the next `migrate` replays
`0000_initial` and dies on the first `CREATE TABLE` whose table already exists.
It does so **silently**: drizzle-kit's migrate progress view renders a rejection
with the same "applying migrations..." text as progress, so `npm run db:migrate`
just exits 1 with no message. Baseline instead of re-running anything:

```bash
node scripts/db-baseline.mjs          # verify each migration's objects are present; write nothing
node scripts/db-baseline.mjs --apply  # record what is verified as present
```

The same script repairs any database that was built by hand or by
`drizzle-kit push`, and it refuses to record a migration whose objects are not
in the database rather than marking unapplied work as applied. A database that
has only ever been migrated by `drizzle-kit migrate` never needs it.

## 5. Seed Sample Data

There is **no seed script**. `npx tsx src/lib/seed.ts` appeared in earlier
versions of this guide but that file does not exist in this repository.

Create a sample position and candidate through the API instead:

```bash
curl -X POST http://localhost:4000/api/positions \
  -H "Content-Type: application/json" \
  -d '{"title":"Senior Full Stack Engineer","level":"Senior","requirements":["React","Node.js"]}'

curl -X POST http://localhost:4000/api/candidates \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Doe","email":"jane@example.com","skills":["React","Node.js"],"experienceYears":5}'
```

The one catalog the database does seed itself is the voice agent's `personas`
table, created and populated by `migrations/0004_add_personas.sql`.

## 6. Set Up Ollama

### Install Ollama

Download from [ollama.com](https://ollama.com) or use the CLI:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### Pull Required Models

```bash
# Chat model (for interview questions)
ollama pull llama3.1

# Embedding model (for vector search)
ollama pull mxbai-embed-large
```

### Verify Ollama is Running

```bash
ollama list
# Should show llama3.1 and mxbai-embed-large
```

Test the API:

```bash
curl http://localhost:11434/api/tags
```

## 7. Audio Services (Optional — for Voice Interviews)

Voice interviews require an audio stack (STT + TTS) maintained in this repository.

| Service | Port | Directory | Purpose |
|---------|------|-----------|---------|
| **audio.cpp** | 8080 | External | Speech-to-text (STT) transcription |
| **Kokoro** | 8081 | `kokoro-service/` | Text-to-speech (TTS) — fast, high quality |
| **Piper** | 8083 | `piper-service/` | Text-to-speech (TTS) — multiple voices |
| **Supertonic** | 8084 | `supertonic-service/` | Text-to-speech (TTS) — 31 languages, 44.1kHz, voice cloning |
| **Audio Gateway** | 8082 | `audio-gateway/` | Unified TTS proxy — routes to Kokoro, Piper, or Supertonic |

### Setup

```bash
# Kokoro (currently ships a Vietnamese model)
cd kokoro-service
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python download_models.py

# Piper
cd ../piper-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# piper-tts is a required import but is NOT in requirements.txt (it is
# GPL-3.0-or-later). Install it explicitly or the service starts with 0 voices:
pip install piper-tts

# Download the English voice for English interviews (optional if only Vietnamese is needed)
# Place in ../pipervoices/:
#   en_US-lessac-medium.onnx
#   en_US-lessac-medium.onnx.json

# Supertonic (model weights download on first use)
cd ../supertonic-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -c "from supertonic import TTS; _ = TTS()"

# Audio Gateway
cd ../audio-gateway
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

See each service's README for detailed setup:

- [`audio-gateway/README.md`](../audio-gateway/README.md)
- [`kokoro-service/README.md`](../kokoro-service/README.md)
- [`piper-service/README.md`](../piper-service/README.md)
- [`supertonic-service/README.md`](../supertonic-service/README.md)

> ⚠️ **Licensing is not uniform across this stack.** The application code is
> MIT, but the TTS models are not: Supertonic's weights are BigScience Open
> RAIL-M, `piper-tts` is GPL-3.0-or-later, and each Piper voice has its own
> license. Read [`NOTICE`](../NOTICE) before distributing a deployment.

**English voice note:** The default English voice mapping expects `en_US-lessac-medium` for Piper and `af_heart` for Kokoro. Piper English voices are downloaded as `.onnx` + `.onnx.json` files into the `pipervoices` directory. Kokoro currently uses the Vietnamese model in this repo; use Piper for English interviews until an English Kokoro model is added.

### Running

```bash
# Start all audio services
npm run start:audio

# Stop all audio services
npm run stop:audio
```

## 8. Start the Backend

```bash
npm run dev
```

The server starts on port `4000` by default.

## 9. Verify Everything Works

1. **Backend health:**

   ```bash
   curl http://localhost:4000/health
   ```

2. **Create a candidate:**

   ```bash
   curl -X POST http://localhost:4000/api/candidates \
     -H "Content-Type: application/json" \
     -d '{"name":"Jane Doe","email":"jane@example.com","skills":["React","Node.js"]}'
   ```

3. **Test with the frontend:** see the frontend repo's [SETUP.md](https://github.com/vdung2k6-myna/adaptive-interview/blob/main/docs/SETUP.md).

## Production Configuration

Set environment variables on your host (Docker, PM2, etc.). The backend does not require a build step, but you can compile TypeScript with:

```bash
npm run build
npm start
```

## Troubleshooting

### Backend Connection Refused

```bash
curl http://localhost:4000/health
```

If it fails, ensure the backend is running:

```bash
npm run dev
```

### Ollama Connection Refused

```bash
ollama ps
ollama serve
```

### Database Connection Error

```bash
pg_isready
```

### pgvector Extension Not Found

```bash
psql ai_interview -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Voice Interview Not Working

```bash
curl http://localhost:4000/api/voice/health
curl http://localhost:8080/health
npm run start:audio
```

### Audio Files Not Found (404 on `/audio/...`)

- Verify `AUDIO_STORAGE_DIR` is set to a writable path.
- On Windows, `/tmp/audio` may not exist — set `AUDIO_STORAGE_DIR` to a valid local path.

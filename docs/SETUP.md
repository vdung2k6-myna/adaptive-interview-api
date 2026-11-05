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

# Per-engine volume: 1 is unchanged. The engines are not equally loud, so these
# are how they are matched. The audio gateway reads them; this server does not.
# Measure with `node scripts/measure-engine-levels.mjs`.
KOKORO_VOLUME=0.5
PIPER_VOLUME=0.7
SUPERTONIC_VOLUME=1.2

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

Migration `0006_enable_pgvector` creates the extension, so `npm run db:migrate` on a
fresh database is enough. The manual command stays safe on a database created before
that migration:

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

### Check the embedding model

The schema casts stored embeddings to `vector(1024)`. Before starting a deployment, and
whenever `OLLAMA_EMBED_MODEL` changes, run:

```bash
npm run check:embed
```

It reads the model's dimension from Ollama and counts stored embedding rows whose
dimension differs. It exits non-zero on either mismatch. The position query casts every
matching row, so one row produced by a differently sized model fails the whole scan.
Regenerate those embeddings — or remove test rows — before retrieval can work.

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

Voice interviews require an audio tier maintained in this repository. It runs as one
compose project: speech-to-text behind a proxy, three TTS engines, and the gateway.

| Service | Port | Directory | Purpose |
|---------|------|-----------|---------|
| **audio.cpp** | 8080 (via proxy) | `audiocpp-service/` | Speech-to-text (STT), pinned upstream CUDA image |
| **Kokoro** | 8081 | `kokoro-service/` | Text-to-speech (TTS) — fast, high quality |
| **Piper** | 8083 | `piper-service/` | Text-to-speech (TTS) — multiple voices |
| **Supertonic** | 8084 | `supertonic-service/` | Text-to-speech (TTS) — 31 languages, 44.1kHz, voice cloning |
| **Audio Gateway** | 8082 | `audio-gateway/` | Unified TTS proxy — routes to Kokoro, Piper, or Supertonic |

Only 8080 and 8082 are published; every engine port stays inside the compose network.

### Setup

```bash
# 1. Provision models once under AUDIO_MODELS_DIR (default ./audio-models):
#    audiocpp, kokoro, piper, supertonic. See docs/AUDIO_TIER.md.

# 2. Start the tier and wait for health:
npm run start:audio
# or: docker compose -f docker-compose.audio.yml up -d --build
```

Docker is required. The STT service needs an NVIDIA GPU and the NVIDIA Container
Toolkit; the TTS engines are CPU-only. See [AUDIO_TIER.md](AUDIO_TIER.md) for host
prerequisites, model provisioning, private binding on a server, and scaling STT.

Per-service READMEs cover the HTTP contracts and the pins:

- [`audiocpp-service/README.md`](../audiocpp-service/README.md)
- [`audio-gateway/README.md`](../audio-gateway/README.md)
- [`kokoro-service/README.md`](../kokoro-service/README.md)
- [`piper-service/README.md`](../piper-service/README.md)
- [`supertonic-service/README.md`](../supertonic-service/README.md)
- [`ovc-service/README.md`](../ovc-service/README.md) — optional voice conversion, below

### Voice conversion (optional)

A deployment may speak every synthesized reply in one voice by routing each WAV
through [`sioaeko/OpenVoiceChanger`](https://github.com/sioaeko/OpenVoiceChanger),
a CPU-capable voice-conversion service. It is **not** a TTS engine: the API
synthesizes the segment with the chosen engine or TTS profile, then converts it
before delivery. The engine or profile still selects the voice that is converted.

| Service | Port | Directory | Purpose |
|---------|------|-----------|---------|
| **OpenVoiceChanger** | 8085 (loopback) | `ovc-service/` | Converts synthesized audio to the service's active model's voice |

```bash
docker compose -f docker-compose.ovc.yml up -d --build   # on the app host
```

Then set `OVC_URL=http://127.0.0.1:8085` and `OVC_MODEL=<the model file name>`
in the API's environment. Unset is off, which is the default. `OVC_REQUIRED`
defaults to true when a URL is set, so a failed conversion fails the turn; set
it false to deliver the unconverted audio and report the failure instead.

The service holds the active model in memory only, so a restarted service comes
back with none and conversion would return the input effectively unchanged. At
boot the API reads `/api/models/active` and activates `OVC_MODEL` when the
service reports no model or a different one; `OVC_ACTIVATION_TIMEOUT_MS`
(default 120000) bounds that activation, which loads and warms the model before
answering.

A deployment may also shape the voice **only for the voice agent**, leaving
interview sessions and the transcript-replay route on the service defaults:

```ini
VOICE_AGENT_OVC_PITCH_SHIFT=12      # semitones, clamped to ±24
VOICE_AGENT_OVC_FORMANT_SHIFT=10    # semitones, clamped to ±24
VOICE_AGENT_OVC_F0_METHOD=rmvpe     # a method the active model advertises
```

Unset or zero is no shaping, which is the default. The F0 method is checked
against the methods `/api/models/active` advertises when the API starts; one it
does not advertise is reported at boot rather than quietly substituted. Because
conversion is required by default, a turn whose method the service refuses fails
rather than speaking in another voice.

A voice-agent turn may also carry a per-turn `ovc` config, which a gadget
console's agent sends through the bridge. `{"enabled":false}` skips conversion
and delivers the TTS provider's audio unchanged; an object overrides the
deployment shaping field by field, and an option it omits inherits. Deploy the
runtime before the console and bridge that send it: an older runtime would treat
the opt-out as a config with no values. Rolling back the bridge's `ovc` field
returns every agent to the deployment default. See `docs/API.md` for the field.

- **One voice at a time.** The service has one active model, so enabling it makes
  the audible voice uniform across engines and profiles; it cannot offer several
  conversion voices at once. Activate a different model to change the voice for
  every turn.
- **Private only.** The service has no authentication. It binds loopback by
  default and must stay on the private network; never publish it. The compose file
  disables its self-update.
- **The model is not MIT.** The code is MIT; the voice model is operator-supplied
  and is a voiceprint of a real person. Its licence and the speaker's consent are
  the deployment's responsibility — see `docs/LICENSE_AUDIT.md` H1 and H3.

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

Migration `0006_enable_pgvector` creates the extension. A database migrated with an older
set needs the command below, or a fresh `npm run db:migrate`. `npm run check:embed` reports
the model's dimension and any stored row that disagrees.

```bash
psql ai_interview -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Voice Interview Not Working

```bash
curl http://localhost:4000/api/voice/health
curl http://localhost:8080/health
npm run start:audio
```

### Audio Files Not Found (`404` or `401` on `/audio/...`)

`/audio` is served behind the API's Bearer token, so a request without a valid one is answered `401` whether or not the file exists — an absent file and a rejected credential are deliberately indistinguishable.

- Verify `AUDIO_STORAGE_DIR` is set to a writable path.
- On Windows, `/tmp/audio` may not exist — set `AUDIO_STORAGE_DIR` to a valid local path.
- A `401` means the request carried no valid `Authorization: Bearer` header, not that the recording is missing.

# Backend Architecture

## System Overview

The `adaptive-interview-api` is a standalone Express server that provides all data access, AI orchestration, and audio processing for the Adaptive Interview Engine. The Next.js frontend is a pure presentation layer: it sends HTTP requests to this backend and renders the responses.

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (Next.js)                      │
│  Pages, Components, Hooks, Styles (port 3000)                  │
└──────────────────────────────┬────────────────────────────────┘
                               │
                     fetch() / apiFetch()
                               │
┌──────────────────────────────┴────────────────────────────────┐
│              ADAPTIVE INTERVIEW API (Express)                 │
│                         port 4000                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Route Handlers (src/routes/*.ts)                        │ │
│  │  ├─ candidates.ts                                       │ │
│  │  ├─ positions.ts                                        │ │
│  │  ├─ sessions.ts                                         │ │
│  │  ├─ campaigns.ts                                        │ │
│  │  ├─ messages.ts   ← streaming                            │ │
│  │  ├─ evaluations.ts                                      │ │
│  │  ├─ voice.ts     ← multipart + SSE                       │ │
│  │  ├─ mcp.ts       ← SSE transport                        │ │
│  │  └─ audio serving (static /audio/*)                     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                               │                               │
│  ┌────────────────────────────┴────────────────────────────┐ │
│  │  Business Logic (src/lib/*.ts)                           │ │
│  │  ├─ prompts.ts       — interview prompt builder         │ │
│  │  ├─ ollama.ts        — Ollama HTTP client               │ │
│  │  ├─ evaluation.ts    — scoring prompt + parser          │ │
│  │  ├─ embeddings.ts    — vector storage + similarity      │ │
│  │  ├─ audio/*.ts       — STT/TTS orchestration            │ │
│  │  └─ position-queries.ts — position lookup helpers        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                               │                               │
│  ┌────────────────────────────┴────────────────────────────┐ │
│  │  Data Access (src/lib/db.ts, src/lib/schema.ts)        │ │
│  │  Drizzle ORM + node-postgres Pool                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                               │                               │
└───────────────────────────────┼───────────────────────────────┘
                                │
                       ┌────────┴────────┐
                       │   PostgreSQL    │
                       │  + pgvector     │
                       └─────────────────┘
```

## Layer Responsibilities

### Route Handlers (`src/routes/`)

- Handle HTTP concerns: status codes, headers, streaming, multipart uploads, SSE
- Validate request bodies and query params
- Call business logic functions
- Return JSON, streams, or audio buffers
- Never call the database directly except through `src/lib/db.ts`

### Business Logic (`src/lib/`)

- Pure TypeScript modules with no Express/React dependencies
- `prompts.ts`: builds interviewer prompts with context, requirements, and topic coverage
- `ollama.ts`: chat, embeddings, streaming helpers
- `evaluation.ts`: builds evaluation prompts and parses structured JSON responses
- `embeddings.ts`: stores requirement/message embeddings and runs cosine similarity
- `audio/*.ts`: STT/TTS clients, text preprocessing (markdown stripping + Kokoro number normalization), WAV utilities, audio gateway calls, and `synthesizeLongText` for combining multiple phoneme-safe chunks into a single audio file
- `position-queries.ts`: small helpers for position lookups

### Data Access (`src/lib/db.ts`, `src/lib/schema.ts`)

- Single Drizzle ORM instance backed by a `pg` Pool
- Schema mirrors the monolith's old `src/lib/schema.ts` so both repos share the same database shape
- Used by route handlers and business logic

## File Organization

```
src/
├── index.ts              # Express server bootstrap, middleware wiring
├── routes/
│   ├── candidates.ts
│   ├── positions.ts
│   ├── sessions.ts
│   ├── campaigns.ts
│   ├── messages.ts       # Streaming text interview
│   ├── evaluations.ts    # Evaluation retrieval + calibration
│   ├── voice.ts          # Voice turn, stream, TTS
│   └── mcp.ts            # MCP SSE transport
├── lib/
│   ├── db.ts             # Drizzle + pg Pool
│   ├── schema.ts         # Drizzle table definitions
│   ├── auth.ts           # Bearer token validation
│   ├── errors.ts         # Custom error classes
│   ├── prompts.ts        # Interview prompt builder
│   ├── ollama.ts         # Ollama client
│   ├── evaluation.ts     # Evaluation prompt + parser
│   ├── embeddings.ts     # Vector storage + similarity
│   ├── position-queries.ts
│   └── audio/
│       ├── client.ts     # audio.cpp + Audio Gateway HTTP clients
│       ├── stt.ts        # Speech-to-text wrapper
│       ├── tts.ts        # Text-to-speech wrapper
│       ├── text-processing.ts  # Markdown strip + number normalization + chunking
│       ├── split-sentences.ts    # Sentence boundary detection
│       ├── wav-utils.ts          # WAV header parse + concat
│       ├── sentence-queue.ts     # Server-side audio queue logic
│       └── storage.ts          # Audio file storage helpers
└── middleware/
    ├── auth.ts           # API auth middleware
    ├── error.ts          # Global error handler
    └── mcpAuth.ts        # MCP auth middleware
```

## Data Flow: Text Interview

```
User submits answer (via frontend)
    │
    ▼
POST /api/messages
    │
    ▼
validateApiAuth()
    │
    ▼
load session + candidate + position + messages
    │
    ▼
embed candidate answer (background-aware, on critical path)
    │
    ▼
buildPrompt(position, candidate, history, covered topics)
    │
    ▼
generateChatResponseStream() → Ollama /api/chat stream:true
    │
    ▼
stream NDJSON chunks via res.write()
    │
    ▼
persist full interviewer message
    │
    ▼
increment currentTurn, mark completed if maxTurns reached
```

## Data Flow: Voice Interview (Standard Turn)

```
Candidate records answer (frontend AudioRecorder)
    │
    ▼
POST /api/voice/turn (multipart: sessionId + audio)
    │
    ▼
multer uploads audio to memory
    │
    ▼
STT: POST audio.cpp /v1/audio/transcriptions
    │
    ▼
store candidate message
    │
    ▼
buildPrompt() → Ollama (non-streaming)
    │
    ▼
TTS: POST Audio Gateway /v1/audio/speech
    │
    ▼
store interviewer message with audioUrl
    │
    ▼
return JSON { candidateMessage, interviewerMessage, session }
```

## Data Flow: Voice Interview (Streaming Turn)

```
Candidate records answer (frontend AudioRecorder)
    │
    ▼
POST /api/voice/stream (multipart + SSE)
    │
    ▼
STT → store candidate message → emit SSE: candidate
    │
    ▼
start Ollama stream
    │
    ▼
WHILE tokens arrive:
    accumulatedText += token
    if sentence delimiter detected:
        fire TTS in background (do not await)
    │
    ▼
after LLM completes:
    await TTS promises in sentence index order
    emit SSE: sentence (index 0, 1, 2...)
    concatenate WAVs → store full message
    emit SSE: done
```

Key implementation points:

- Sentence boundaries are detected incrementally during LLM token streaming.
- TTS calls start in the background as soon as a sentence is detected.
- `sentence` events are emitted sequentially by index after LLM completion, so the client receives them in order.
- Remaining text after the LLM finishes is flushed as a final sentence.

## Data Flow: Evaluation (Async)

```
Frontend: POST /api/sessions/:id/evaluate
    │
    ▼
Backend creates evaluation job
    │
    ▼
return 202 { jobId, status: "running" }
    │
    ▼
Frontend polls GET /api/evaluations/jobs/:jobId every 2s
    │
    ▼
Backend (async):
    load transcript
    buildEvaluationPrompt()
    call Ollama (temperature 0.3)
    parse JSON response
    create evaluation version
    │
    ▼
return { status: "completed", result } or { status: "failed", error }
```

## MCP Analytics Server

The MCP server is embedded in the Express app at `/api/mcp`. It uses the `@modelcontextprotocol/sdk` `McpServer` with a custom `ExpressSseTransport` that writes SSE events directly to the response stream.

```
External AI client (Claude Desktop / Inspector)
    │
    ▼
GET /api/mcp (SSE)
    │
    ▼
validateMcpAuth()
    │
    ▼
ExpressSseTransport connects to McpServer
    │
    ▼
Sends endpoint event + tools/list
    │
    ▼
Client POSTs tools/call to /api/mcp?sessionId=...
    │
    ▼
Tool handler queries DB via Drizzle
    │
    ▼
Anonymize results (strip PII, replace candidateId with stable UUID)
    │
    ▼
Return result via SSE message event
```

All MCP tools are read-only. The anonymization layer lives in `src/lib/mcp/tools/_anonymize.ts`.

## Audio Services

Voice interviews rely on external audio services orchestrated by the backend:

```
Express Backend
    │ POST /v1/audio/speech { text, engine, voice }
    ▼
Audio Gateway (port 8082)
    ├─ engine=kokoro ──▶ Kokoro TTS (port 8081)
    │   voice resolved from session.language → config.audio.voices.kokoro
    └─ engine=piper  ──▶ Piper TTS (port 8083)
        voice resolved from session.language → config.audio.voices.piper

Express Backend
    │ POST /v1/audio/transcriptions
    ▼
audio.cpp STT (port 8080)
```

Audio files generated by the backend are stored on the local filesystem under `AUDIO_STORAGE_DIR` (default `/tmp/audio/{sessionId}/`) and served statically at `/audio/{sessionId}/{filename}`.

## Interview Language

Every `interview_sessions` row stores `language` (`english` \| `vietnamese`, default `english`). The value is used in three places:

1. **Question generation** — the system prompt in `src/lib/prompts.ts` instructs the LLM to conduct the interview in the configured language only.
2. **TTS voice selection** — `resolveVoice(engine, language)` maps `(engine, language)` to a configured voice ID. Vietnamese voices intentionally default to the service's installed default so existing deployments keep working.
3. **Evaluation** — the evaluation system prompt in `src/lib/evaluation.ts` asks the LLM to write strengths, weaknesses, and other feedback in the configured language.

## Middleware

| Middleware | File | Purpose |
|------------|------|---------|
| CORS | `src/index.ts` | Allow requests from `FRONTEND_URL` |
| API Auth | `src/middleware/auth.ts` | Validate `Authorization: Bearer` against `API_AUTH_TOKEN` |
| MCP Auth | `src/middleware/mcpAuth.ts` | Validate MCP token |
| Error Handler | `src/middleware/error.ts` | Catch unhandled errors and return JSON |

## Environment Configuration

Runtime configuration is loaded from `.env` via `dotenv`. Key variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection |
| `OLLAMA_BASE_URL` | Ollama API endpoint |
| `OLLAMA_MODEL` | Default chat model |
| `OLLAMA_EMBED_MODEL` | Embedding model |
| `API_AUTH_TOKEN` | Enables Bearer token auth when set |
| `MCP_AUTH_TOKEN` | MCP endpoint token |
| `MCP_ENABLED` | Enables/disables MCP route |
| `AUDIO_STORAGE_DIR` | Audio file storage path |
| `AUDIOCPP_BASE_URL` | STT server URL |
| `AUDIO_GATEWAY_URL` | TTS gateway URL |
| `DEFAULT_TTS_ENGINE` | `kokoro` or `piper` |
| `DEFAULT_VOICE` | Default voice ID |
| `KOKORO_VOICE_ENGLISH` | English voice ID for Kokoro (default `af_heart`) |
| `PIPER_VOICE_ENGLISH` | English voice ID for Piper (default `en_US-lessac-medium`) |
| `KOKORO_VOICE_VIETNAMESE` | Override Vietnamese voice ID for Kokoro (empty = service default) |
| `PIPER_VOICE_VIETNAMESE` | Override Vietnamese voice ID for Piper (empty = service default) |
| `FRONTEND_URL` | CORS origin |
| `PORT` | Server port (default 4000) |

## Conventions

- Route handlers validate inputs manually or with Zod before calling business logic.
- Business logic functions are pure TypeScript and return plain data structures.
- Streaming endpoints use `res.write()` with `text/plain` or `text/event-stream` content types.
- Audio routes use `multer` with `memoryStorage` for temporary uploads.
- All errors are caught by the global error handler and returned as `{ error: string }`.

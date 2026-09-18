# API Documentation

## Base URL

The Adaptive Interview Engine API is served by the standalone Express backend (`adaptive-interview-api`, port `4000` by default).

In development, the Next.js frontend proxies requests from `/api/*` and `/audio/*` to the backend:

```
Frontend: http://localhost:3000/api/...  →  Backend: http://localhost:4000/api/...
Frontend: http://localhost:3000/audio/... →  Backend: http://localhost:4000/audio/...
```

In production, a reverse proxy (nginx, Vercel, etc.) should route `/api/*` and `/audio/*` to the backend.

## Authentication

All API routes require a Bearer token when `API_AUTH_TOKEN` is configured. Token validation is performed by the Express backend.

**Header:**

```
Authorization: Bearer <token>
```

**Behavior:**

- If `API_AUTH_TOKEN` is set in the backend, every API route returns `401 Unauthorized` without a valid Bearer token.
- If `API_AUTH_TOKEN` is not set, auth is disabled (backward-compatible for local development).
- The MCP endpoint (`/api/mcp`) has its own token (`MCP_AUTH_TOKEN`) and checks both tokens when auth is enabled.

Clients (including the Next.js frontend) are responsible for sending the header. The frontend uses its own `apiFetch()` wrapper, which reads `NEXT_PUBLIC_API_TOKEN`.

---

## Candidates

### `POST /api/candidates`

Create a new candidate.

**Request Body:**

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "skills": ["React", "Node.js", "TypeScript"],
  "experienceYears": 5,
  "cv": "Full-stack developer with 5 years experience..."
}
```

**Required fields:** `name`, `email`, `skills`  
**Optional fields:** `experienceYears`, `cv`

**Response:**

```json
{
  "id": "uuid",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "skills": ["React", "Node.js", "TypeScript"],
  "experienceYears": 5,
  "cv": "Full-stack developer...",
  "createdAt": "2026-08-08T12:00:00Z"
}
```

**Status Codes:**

- `201` — Created
- `400` — Validation error (missing required fields)
- `500` — Database error

---

### `GET /api/candidates`

List all candidates with `sessionCount` appended.

**Response:**

```json
[
  {
    "id": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "skills": ["React", "Node.js", "TypeScript"],
    "experienceYears": 5,
    "cv": "Full-stack developer...",
    "createdAt": "2026-08-08T12:00:00Z",
    "sessionCount": 2
  }
]
```

**Status Codes:**

- `200` — Success
- `500` — Database error

---

### `GET /api/candidates/:id`

Fetch a single candidate.

**Response:** Same shape as `POST` response.

**Status Codes:**

- `200` — Success
- `404` — Candidate not found

---

### `PATCH /api/candidates/:id`

Update a candidate. Blocked if the candidate is referenced by any interview session.

**Request Body:**

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "skills": ["React", "Node.js", "TypeScript"],
  "experienceYears": 5,
  "cv": "Updated resume..."
}
```

**Status Codes:**

- `200` — Updated
- `404` — Candidate not found
- `409` — Conflict: candidate is referenced by existing sessions

---

### `DELETE /api/candidates/:id`

Delete a candidate. Blocked if referenced by any session.

**Status Codes:**

- `200` — Deleted
- `404` — Candidate not found
- `409` — Conflict: candidate is referenced by existing sessions

---

## Positions

### `POST /api/positions`

Create a new position.

**Request Body:**

```json
{
  "title": "Senior Full Stack Engineer",
  "level": "Senior",
  "jobDescription": "We are looking for a senior engineer to lead our platform team...",
  "requirements": ["React", "Node.js", "PostgreSQL", "System Design"]
}
```

**Required fields:** `title`, `level`, `requirements`  
**Optional fields:** `jobDescription`

**Response:**

```json
{
  "id": "uuid",
  "title": "Senior Full Stack Engineer",
  "level": "Senior",
  "jobDescription": "We are looking for a senior engineer to lead our platform team...",
  "requirements": ["React", "Node.js", "PostgreSQL", "System Design"],
  "createdAt": "2026-08-08T12:00:00Z"
}
```

**Status Codes:**

- `201` — Created
- `400` — Validation error
- `500` — Database error

---

### `GET /api/positions`

List all positions with `sessionCount` appended.

**Response:**

```json
[
  {
    "id": "uuid",
    "title": "Senior Full Stack Engineer",
    "level": "Senior",
    "jobDescription": "We are looking for a senior engineer...",
    "requirements": ["React", "Node.js", "PostgreSQL", "System Design"],
    "createdAt": "2026-08-08T12:00:00Z",
    "sessionCount": 3
  }
]
```

**Status Codes:**

- `200` — Success
- `500` — Database error

---

### `GET /api/positions/:id`

Fetch a single position.

**Response:** Same shape as `POST` response.

**Status Codes:**

- `200` — Success
- `404` — Position not found

---

### `PATCH /api/positions/:id`

Update a position. Blocked if the position is referenced by any interview session.

**Request Body:**

```json
{
  "title": "Senior Full Stack Engineer",
  "level": "Senior",
  "jobDescription": "Updated description...",
  "requirements": ["React", "Node.js", "PostgreSQL", "System Design"]
}
```

**Status Codes:**

- `200` — Updated
- `404` — Position not found
- `409` — Conflict: position is referenced by existing sessions

---

### `DELETE /api/positions/:id`

Delete a position. Blocked if referenced by any session.

**Status Codes:**

- `200` — Deleted
- `404` — Position not found
- `409` — Conflict: position is referenced by existing sessions

---

## Sessions

### `POST /api/sessions`

Create a new interview session.

**Request Body:**

```json
{
  "positionId": "uuid",
  "candidateId": "uuid",
  "mode": "voice",
  "ttsProvider": "piper",
  "language": "vietnamese"
}
```

**Required fields:** `positionId`, `candidateId`  
**Optional fields:**

- `mode` (`"text"` or `"voice"`, defaults to `"text"`)
- `ttsProvider` (`"kokoro"` or `"piper"`, defaults to `"kokoro"`; only used when `mode` is `"voice"`)
- `language` (`"english"` or `"vietnamese"`, defaults to `"english"`)
- `maxTurns` (`number`, defaults to `8`)

**Response:**

```json
{
  "id": "uuid",
  "positionId": "uuid",
  "candidateId": "uuid",
  "status": "created",
  "mode": "voice",
  "ttsProvider": "piper",
  "language": "vietnamese",
  "maxTurns": 8,
  "currentTurn": 0,
  "createdAt": "2026-08-08T12:00:00Z"
}
```

**Status Codes:**

- `201` — Created
- `400` — Missing positionId or candidateId
- `500` — Database error

---

### `GET /api/sessions`

List all sessions (used by dashboard).

**Response:**

```json
[
  {
    "id": "uuid",
    "status": "completed",
    "maxTurns": 8,
    "currentTurn": 8,
    "createdAt": "2026-08-08T12:00:00Z",
    "completedAt": "2026-08-08T12:15:00Z",
    "candidate": {
      "id": "uuid",
      "name": "Jane Doe",
      "email": "jane@example.com"
    },
    "position": {
      "id": "uuid",
      "title": "Senior Full Stack Engineer",
      "level": "Senior"
    },
    "evaluation": {
      "overallScore": 4,
      "recommendation": "yes"
    }
  }
]
```

**Status Codes:**

- `200` — Success
- `500` — Database error

---

### `GET /api/sessions/:id`

Get a single session with all related data.

**Response:**

```json
{
  "session": {
    "id": "uuid",
    "status": "completed",
    "mode": "voice",
    "language": "vietnamese",
    "maxTurns": 8,
    "currentTurn": 8,
    "createdAt": "2026-08-08T12:00:00Z",
    "completedAt": "2026-08-08T12:15:00Z"
  },
  "candidate": {
    "id": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "skills": ["React", "Node.js"],
    "experienceYears": 5
  },
  "position": {
    "id": "uuid",
    "title": "Senior Full Stack Engineer",
    "level": "Senior",
    "requirements": ["React", "Node.js", "PostgreSQL"]
  },
  "messages": [
    {
      "id": "uuid",
      "role": "interviewer",
      "content": "What is your experience with React?",
      "createdAt": "2026-08-08T12:01:00Z"
    },
    {
      "id": "uuid",
      "role": "candidate",
      "content": "I've been using React for 5 years...",
      "createdAt": "2026-08-08T12:02:00Z"
    }
  ]
}
```

**Status Codes:**

- `200` — Success
- `404` — Session not found

---

## Messages

### `POST /api/messages`

Submit a candidate answer or trigger the first question. Returns a streaming response.

**Request Body:**

```json
// First question (no content)
{
  "sessionId": "uuid"
}

// Subsequent answer
{
  "sessionId": "uuid",
  "content": "I've been using React for 5 years..."
}
```

**Response:**

Returns a stream of NDJSON chunks:

```
{"message": {"content": "What"}}
{"message": {"content": " is"}}
{"message": {"content": " your"}}
...
```

**Status Codes:**

- `200` — Stream started
- `400` — Missing sessionId or invalid request
- `404` — Session not found
- `500` — Ollama error

**Important:** This endpoint returns a stream, not a JSON object. The client must read the response body incrementally.

---

## Voice Interview

### `POST /api/voice/start`

Generate the first interview question for a voice session, synthesize it to audio, and return the message with audio URL.

**Request Body:**

```json
{
  "sessionId": "uuid"
}
```

**Response:**

```json
{
  "success": true,
  "interviewerMessage": {
    "id": "uuid",
    "content": "What is your experience with React?",
    "audioUrl": "/audio/{sessionId}/{msgId}.wav",
    "createdAt": "2026-08-17T10:00:00Z"
  },
  "session": {
    "status": "in_progress",
    "currentTurn": 0,
    "maxTurns": 8
  }
}
```

**Status Codes:**

- `200` — Question generated and synthesized
- `400` — Missing sessionId
- `404` — Session not found
- `409` — Session already has messages
- `503` — Ollama or audio.cpp unavailable

---

### `POST /api/voice/turn`

Process a single voice turn: transcribe candidate audio, generate next question, synthesize audio response.

**Request:** `multipart/form-data`

```
sessionId: string (UUID)
audio: Blob (audio/webm or audio/wav)
```

**Response:**

```json
{
  "success": true,
  "candidateMessage": {
    "id": "uuid",
    "content": "Transcribed text from STT",
    "audioUrl": "/audio/{sessionId}/{msgId}.webm",
    "createdAt": "2026-08-17T10:00:00Z"
  },
  "interviewerMessage": {
    "id": "uuid",
    "content": "AI-generated question text",
    "audioUrl": "/audio/{sessionId}/{msgId}.wav",
    "createdAt": "2026-08-17T10:00:05Z"
  },
  "session": {
    "status": "in_progress",
    "currentTurn": 3,
    "maxTurns": 8
  }
}
```

**Status Codes:**

- `200` — Turn processed successfully
- `400` — Missing sessionId or audio
- `403` — Session is text mode or already completed
- `404` — Session not found
- `500` — STT, TTS, or LLM failure

---

### `POST /api/voice/stream`

**Streaming voice turn** via Server-Sent Events (SSE). Same functionality as `/api/voice/turn` but detects sentence boundaries **incrementally during LLM token streaming**, fires TTS for each completed sentence in the background, and emits `sentence` events as audio becomes ready.

**Key difference from `/api/voice/turn`:**

- `/api/voice/turn` waits for the full LLM response (~8s), then synthesizes all audio (~5s) — candidate waits ~16–20s before hearing anything.
- `/api/voice/stream` starts TTS as soon as the first sentence is complete (~3–4s into LLM generation) — candidate hears first audio within ~5–6s.

**Request:** `multipart/form-data`

```
sessionId: string (UUID)
audio: Blob (audio/webm or audio/wav)
```

**Response:** `text/event-stream`

| Event | Data Shape | Description |
|-------|-----------|-------------|
| `candidate` | `{ text, audioUrl, confidence, messageId }` | Candidate transcription stored |
| `sentence` | `{ index, text, audioUrl }` | A sentence chunk ready to play |
| `done` | `{ session, messageId, fullText, audioUrl }` | All chunks complete; full audio saved |
| `error` | `{ message }` | Fatal error (stream terminates) |

**Text preprocessing:**

Before TTS, markdown formatting is stripped (bold, italic, headers, code blocks, inline code, lists, blockquotes). Long sentences are split into ~60-character chunks at natural boundaries (`:` > `;` > `,` > `space`). If a chunk still exceeds the TTS engine's phoneme limit, it is recursively halved and retried; successful WAV halves are concatenated so no audio is lost.

**Incremental emission:**

`sentence` events are emitted **during** LLM generation, not after. As the LLM streams tokens, the server detects sentence boundaries (`.`, `!`, `?`, `…`, `。`, `？`, `！`) and immediately fires TTS for each completed sentence. The `sentence` SSE event is sent only when TTS returns, but TTS itself starts as soon as the sentence is detected — typically while the LLM is still generating subsequent sentences.

**Example SSE flow:**

```
event: candidate
data: {"text":"I have 5 years of React experience...","audioUrl":"/audio/.../candidate.webm","confidence":0.92,"messageId":"msg-1"}

event: sentence
data: {"index":0,"text":"Câu hỏi đầu tiên.","audioUrl":"/audio/.../chunk-0.wav"}

event: sentence
data: {"index":1,"text":"Bạn hãy giải thích về closure trong JavaScript.","audioUrl":"/audio/.../chunk-1.wav"}

event: done
data: {"session":{"status":"in_progress","currentTurn":3,"maxTurns":8},"messageId":"msg-2","fullText":"Câu hỏi đầu tiên. Bạn hãy giải thích...","audioUrl":"/audio/.../interviewer.wav"}
```

**Status Codes:**

- `200` — SSE stream opened (errors delivered as `event: error`)
- `400` — Missing sessionId or audio

---

### `GET /audio/{sessionId}/{filename}`

Serve a stored audio file. Files are organized under the configured `AUDIO_STORAGE_DIR` (default `/tmp/audio/{sessionId}/`).

**Response:** Audio stream (`audio/wav`, `audio/webm`, or `audio/mpeg`)

**Status Codes:**

- `200` — Audio file served
- `404` — File not found

---

### `POST /api/voice/speak`

On-demand TTS for transcript replay. Synthesizes any text to speech via the Audio Gateway.

**Request Body:**

```json
{
  "text": "Hello, this is a test.",
  "engine": "piper",
  "voice": "en_US-lessac-medium",
  "language": "english"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | Yes | Text to synthesize |
| `engine` | `"kokoro"` \| `"piper"` | No | Default: `"kokoro"` |
| `voice` | `string` | No | Explicit voice ID override |
| `language` | `"english"` \| `"vietnamese"` | No | Default: `"english"`; selects the configured voice unless `voice` is provided |

**Response:** `audio/wav` — WAV audio stream.

**Text preprocessing:**

Markdown formatting (bold, italic, strikethrough, headers, code blocks, inline code, lists, blockquotes, links, images, horizontal rules) is stripped before synthesis so TTS engines do not speak formatting characters.

**Status Codes:**

- `200` — Audio synthesized
- `400` — Missing text
- `500` — TTS failure

---

### `POST /api/voice/speak-stream`

**Streaming TTS for transcript replay** via Server-Sent Events (SSE). Same functionality as `/api/voice/speak` but splits text into sentences server-side, synthesizes each sentence in order, and emits `sentence` events with embedded base64 audio data as each chunk becomes ready. Embedding the audio data removes a per-chunk HTTP fetch round-trip, so playback starts as soon as the first chunk arrives.

**Request Body:**

```json
{
  "text": "Hello. How are you? **This** is a test.",
  "engine": "piper",
  "language": "english"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | Yes | Text to synthesize |
| `engine` | `"kokoro"` \| `"piper"` | No | Default: `"kokoro"` |
| `language` | `"english"` \| `"vietnamese"` | No | Default: `"english"`; selects the configured voice for the engine |

**Response:** `text/event-stream`

| Event | Data Shape | Description |
|-------|-----------|-------------|
| `sentence` | `{ index, text, audioData }` | A sentence chunk ready to play |
| `done` | `{}` | All sentences processed |
| `error` | `{ message }` | Fatal error (stream terminates) |

**Example SSE flow:**

```
event: sentence
data: {"index":0,"text":"Hello.","audioData":"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA..."}

event: sentence
data: {"index":1,"text":"How are you?","audioData":"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA..."}

event: done
data: {}
```

---

## Voice Agent

### `POST /api/voice-agent/stream`

**Ephemeral voice/text chat with a configurable AI agent.** No session, candidate, or position is required. Conversations are not persisted.

The endpoint accepts either an audio recording (voice input) or a `text` field (text input), plus agent configuration. On the first turn, omit both `audio` and `text` to receive the agent's opening message.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `audio` | `Blob` (`audio/wav` or `audio/webm`) | No | User voice recording. Omit on first turn or when using text input. |
| `text` | `string` | No | User text message. Alternative to `audio`. |
| `language` | `"english"` \| `"vietnamese"` | Yes | Conversation language and TTS voice selector. |
| `engine` | `"kokoro"` \| `"piper"` | Yes | Requested TTS engine (runtime may force an engine based on `language`). |
| `systemPrompt` | `string` | Yes | Agent behavior/persona prompt. |
| `history` | `JSON string` | Yes | Array of `{ role: "agent" \| "user", content: string }`. |

**Response:** `text/event-stream`

| Event | Data Shape | Description |
|-------|-----------|-------------|
| `user` | `{ text, messageId }` | Transcribed user audio or the provided `text`. Omitted on the first turn. |
| `sentence` | `{ index, text, audioData }` | A synthesized agent sentence as base64 WAV. `audioData` is `null` if synthesis failed. |
| `done` | `{ messageId, fullText }` | Agent response complete. |
| `error` | `{ message }` | Fatal error (stream terminates). |

**Text preprocessing:**

Same Markdown stripping and sentence splitting as the voice interview endpoints. The engine and voice are resolved via `resolveEngineForLanguage(engine, language)` and `resolveVoice(engine, language)`.

**History cap:**

The backend keeps only the most recent `VOICE_AGENT_MAX_HISTORY` exchanges in the LLM context (default `20`). Older pairs are dropped from the prompt, but the caller may keep the full local history for display.

**Example SSE flow:**

```
event: user
data: {"text":"Explain closures.","messageId":"user-1"}

event: sentence
data: {"index":0,"text":"A closure is a function that remembers the variables from its surrounding scope.","audioData":"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA..."}

event: done
data: {"messageId":"agent-1","fullText":"A closure is a function that remembers the variables from its surrounding scope."}
```

**Status Codes:**

- `200` — SSE stream opened (errors delivered as `event: error`)
- `400` — Missing `systemPrompt` or invalid configuration

---

## Audio Gateway (External Service)

The Audio Gateway is a standalone FastAPI service in `audio-gateway/` that provides a unified TTS endpoint. The Express backend routes all TTS requests through this gateway; clients never contact it directly.

### `POST /v1/audio/speech` (Gateway)

**Request Body:**

```json
{
  "text": "Xin chào, bạn khỏe không?",
  "engine": "piper",
  "voice": "vi_VN-vais1000-medium"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | Yes | Text to synthesize |
| `engine` | `"kokoro"` \| `"piper"` | No | Default: `"kokoro"` |
| `voice` | `string` | No | Voice ID (passed through to downstream) |
| `model` | `string` | No | Model override (Kokoro only) |

**Response:** `audio/wav` — WAV audio stream.

**Errors:**

- `400` — Missing text or unknown engine
- `502` — Downstream TTS service error
- `504` — Downstream TTS timeout

### `GET /health` (Gateway)

```json
{
  "status": "ok",
  "gateway": true,
  "kokoro": true,
  "piper": true
}
```

---

## Evaluations

### `GET /api/evaluations/:sessionId`

Get the latest evaluation and version history for a completed session.

**Response:**

```json
{
  "latest": {
    "id": "uuid",
    "sessionId": "uuid",
    "model": "llama3.1",
    "aiScores": {
      "technicalDepth": 4,
      "communicationClarity": 4,
      "problemSolving": 3,
      "relevanceToRole": 5
    },
    "humanScores": {
      "technicalDepth": 4,
      "communicationClarity": 5,
      "problemSolving": 4,
      "relevanceToRole": 5
    },
    "aiRecommendation": "yes",
    "humanRecommendation": "yes",
    "humanCalibrated": true,
    "confidence": 82,
    "strengths": ["Strong React knowledge", "Clear communication"],
    "weaknesses": ["Could dig deeper into system design"],
    "recruiterNotes": "Strong candidate, recommend follow-up on system design",
    "rawResponse": "{\"technical_depth\": 4, ...}",
    "createdAt": "2026-08-08T12:20:00Z"
  },
  "versions": [
    {
      "id": "uuid",
      "model": "llama3.1",
      "humanCalibrated": true,
      "createdAt": "2026-08-08T12:20:00Z"
    }
  ]
}
```

**Status Codes:**

- `200` — Success
- `404` — Evaluation not found

---

### `GET /api/evaluations/versions/:versionId`

Get a specific evaluation version by ID.

**Response:** Same shape as `latest` above.

**Status Codes:**

- `200` — Success
- `404` — Version not found

---

### `POST /api/sessions/:id/evaluate`

Generate a new evaluation for a completed session. Creates a new version — never overwrites existing evaluations.

This endpoint is **asynchronous**. It returns immediately with a `jobId` that the client must poll via `GET /api/evaluations/jobs/:jobId`.

**Request Body (optional):**

```json
{
  "model": "llama3.2"
}
```

**Response:**

```json
{
  "jobId": "uuid",
  "status": "running"
}
```

**Status Codes:**

- `202` — Evaluation job started
- `400` — Interview not completed
- `404` — Session not found
- `500` — Ollama error or parse failure

---

### `GET /api/evaluations/jobs/:jobId`

Poll the status of an async evaluation job. Call every 2 seconds after receiving the `jobId` from `POST /api/sessions/:id/evaluate`.

**Response:**

```json
{
  "id": "uuid",
  "status": "running"
}
```

When completed:

```json
{
  "id": "uuid",
  "status": "completed",
  "result": {
    "id": "uuid",
    "sessionId": "uuid",
    "model": "llama3.1",
    "aiScores": {
      "technicalDepth": 4,
      "communicationClarity": 4,
      "problemSolving": 3,
      "relevanceToRole": 5
    },
    "aiRecommendation": "yes",
    "confidence": 82,
    "strengths": ["Strong React knowledge", "Clear communication"],
    "weaknesses": ["Could dig deeper into system design"],
    "rawResponse": "{\"technical_depth\": 4, ...}",
    "createdAt": "2026-08-08T12:20:00Z"
  }
}
```

When failed:

```json
{
  "id": "uuid",
  "status": "failed",
  "error": "Ollama returned invalid JSON"
}
```

**Status Codes:**

- `200` — Job status returned
- `404` — Job not found

---

### `PATCH /api/evaluations/:sessionId`

Update human calibration scores, human recommendation, and recruiter notes on the latest evaluation version.

**Request Body:**

```json
{
  "humanScores": {
    "technicalDepth": 4,
    "communicationClarity": 5,
    "problemSolving": 4,
    "relevanceToRole": 5
  },
  "humanRecommendation": "yes",
  "recruiterNotes": "Strong candidate, recommend follow-up on system design"
}
```

**Response:** Updated `{ latest: {...} }` object.

**Status Codes:**

- `200` — Success
- `404` — Evaluation not found

---

### `DELETE /api/evaluations/versions/:versionId`

Delete a non-latest evaluation version.

**Status Codes:**

- `200` — Success
- `400` — Cannot delete the latest version
- `404` — Version not found

---

## Campaigns

### `POST /api/campaigns`

Create a new recruiting campaign.

**Request Body:**

```json
{
  "name": "Q3 2026 Engineering Hiring",
  "description": "Fall hiring push for backend and frontend roles",
  "startDate": "2026-07-01",
  "endDate": "2026-09-30",
  "tags": ["engineering", "urgent"],
  "positionIds": ["uuid-1", "uuid-2"]
}
```

**Required fields:** `name`  
**Optional fields:** `description`, `startDate`, `endDate`, `tags`, `positionIds`, `status`

**Response:**

```json
{
  "id": "uuid",
  "name": "Q3 2026 Engineering Hiring",
  "description": "Fall hiring push...",
  "startDate": "2026-07-01T00:00:00.000Z",
  "endDate": "2026-09-30T00:00:00.000Z",
  "tags": ["engineering", "urgent"],
  "status": "draft",
  "createdAt": "2026-08-09T12:00:00Z"
}
```

**Status Codes:**

- `201` — Created
- `400` — Validation error (missing name)
- `500` — Database error

---

### `GET /api/campaigns`

List all campaigns with aggregated metrics.

**Response:**

```json
[
  {
    "id": "uuid",
    "name": "Q3 2026 Engineering Hiring",
    "description": "Fall hiring push...",
    "startDate": "2026-07-01T00:00:00.000Z",
    "endDate": "2026-09-30T00:00:00.000Z",
    "tags": ["engineering", "urgent"],
    "status": "draft",
    "createdAt": "2026-08-09T12:00:00Z",
    "positionCount": 2,
    "sessionCount": 5
  }
]
```

**Status Codes:**

- `200` — Success
- `500` — Database error

---

### `GET /api/campaigns/:id`

Fetch a single campaign with its positions and aggregated metrics.

**Response:**

```json
{
  "id": "uuid",
  "name": "Q3 2026 Engineering Hiring",
  "description": "Fall hiring push...",
  "startDate": "2026-07-01T00:00:00.000Z",
  "endDate": "2026-09-30T00:00:00.000Z",
  "tags": ["engineering", "urgent"],
  "status": "draft",
  "createdAt": "2026-08-09T12:00:00Z",
  "positions": [
    {
      "id": "uuid",
      "title": "Senior Full Stack Engineer",
      "level": "Senior",
      "requirements": ["React", "Node.js"],
      "createdAt": "2026-08-09T12:00:00Z",
      "sessionCount": 3
    }
  ],
  "metrics": {
    "totalSessions": 5,
    "completionRate": 80,
    "avgAiScore": 3.8,
    "avgHumanScore": 4.2
  },
  "recommendations": {
    "strong_yes": 1,
    "yes": 2,
    "maybe": 1
  },
  "topCandidates": [
    {
      "sessionId": "uuid",
      "candidateName": "Jane Doe",
      "aiAvg": 4.5,
      "humanAvg": 4.8,
      "recommendation": "strong_yes"
    }
  ]
}
```

**Status Codes:**

- `200` — Success
- `404` — Campaign not found

---

### `PATCH /api/campaigns/:id`

Update a campaign.

**Request Body:**

```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "startDate": "2026-08-01",
  "endDate": "2026-10-31",
  "tags": ["engineering"],
  "status": "active"
}
```

**Status Codes:**

- `200` — Updated
- `404` — Campaign not found
- `500` — Database error

---

### `DELETE /api/campaigns/:id`

Delete a campaign. Also deletes associated `campaign_positions` rows via CASCADE.

**Status Codes:**

- `200` — Deleted
- `404` — Campaign not found
- `500` — Database error

---

### `POST /api/campaigns/:id/positions`

Add a position to a campaign.

**Request Body:**

```json
{
  "positionId": "uuid"
}
```

**Status Codes:**

- `201` — Added
- `400` — Missing positionId
- `500` — Database error

---

### `DELETE /api/campaigns/:id/positions?positionId=uuid`

Remove a position from a campaign.

**Status Codes:**

- `200` — Removed
- `400` — Missing positionId query param
- `500` — Database error

---

## MCP Analytics Server

### `GET /api/mcp`

Establish an SSE connection for the Model Context Protocol (MCP). External AI clients (Claude Desktop, Inspector, etc.) can connect to this endpoint to query interview data via structured tools.

**Headers:**

```
Authorization: Bearer <MCP_AUTH_TOKEN>
Accept: text/event-stream
```

**Protocol:**

1. Client opens SSE connection
2. Server sends `endpoint` event with a URL for POSTing messages
3. Server sends `tools/list` with available tool definitions
4. Client POSTs `tools/call` messages to the endpoint URL
5. Server sends results back via SSE `message` events

**Status Codes:**

- `200` — SSE stream established
- `401` — Invalid or missing auth token

---

### `POST /api/mcp?sessionId=<id>`

Send a JSON-RPC message to an active MCP session. The `sessionId` must match the one returned in the SSE `endpoint` event.

**Headers:**

```
Authorization: Bearer <MCP_AUTH_TOKEN>
Content-Type: application/json
```

**Body:** JSON-RPC message (request or notification)

**Status Codes:**

- `200` — Message received
- `400` — Invalid JSON or missing sessionId
- `401` — Invalid or missing auth token
- `404` — Session not found or expired

---

### MCP Tools

All tools are **read-only** and return **anonymized** data (no candidate names, emails, or CVs).

#### `listCampaigns`

List all recruiting campaigns with position and session counts.

**Input:** `{ status?: string }`

**Output:** Array of `{ id, name, description, status, positionCount, sessionCount }`

---

#### `getCampaignAnalytics`

Get aggregated analytics for a campaign.

**Input:** `{ campaignId: string }`

**Output:**

```json
{
  "averageScores": {
    "technicalDepth": 4.2,
    "communicationClarity": 3.8,
    "problemSolving": 4.0,
    "relevanceToRole": 4.5
  },
  "totalSessions": 12,
  "completedSessions": 10,
  "topSkills": ["React", "System Design", "Node.js"],
  "weakAreas": ["Database Optimization", "Testing"]
}
```

---

#### `listSessions`

List interview sessions with anonymized candidate info.

**Input:** `{ status?: string, limit?: number }`

**Output:** Array of `{ id, positionTitle, level, candidateUuid, status, currentTurn, maxTurns, createdAt }`

---

#### `getSessionSummary`

Get a summary of a single session (no transcript content).

**Input:** `{ sessionId: string }`

**Output:** `{ id, positionTitle, level, candidateUuid, status, messageCount, evaluation?: { scores, recommendation, confidence, strengths, weaknesses } }`

---

#### `listPositions`

List all positions with requirements and session counts.

**Input:** `{ level?: string }`

**Output:** Array of `{ id, title, level, requirements, sessionCount }`

---

#### `searchCandidatesBySkill`

Search candidates by skill (anonymized).

**Input:** `{ skill: string, limit?: number }`

**Output:** Array of `{ candidateUuid, matchedSkills, experienceYears }`

---

## Error Format

All API errors follow this structure:

```json
{
  "error": "Human-readable error message"
}
```

**Common HTTP Status Codes:**

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `202` | Accepted (async job started) |
| `400` | Bad Request (validation error) |
| `401` | Unauthorized (missing or invalid Bearer token) |
| `403` | Forbidden (e.g. text-mode session used for voice) |
| `404` | Not Found |
| `409` | Conflict (entity referenced by sessions) |
| `500` | Internal Server Error |
| `502` | Bad Gateway (Ollama returned invalid response) |
| `503` | Service Unavailable (audio/Ollama unavailable) |
| `504` | Gateway Timeout (Ollama request timed out) |

## Rate Limiting

Currently, there is no rate limiting. This is acceptable for local/internal use but should be added before public deployment.

# Backend Security

The security posture of the Express API in this repository: what an operator has to get right to
deploy it safely, and how each property is actually enforced in code.

Frontend-side concerns — HTML injection through rendered interviewer messages, the client's API
token, browser microphone and playback privacy — live in
[`adaptive-interview/docs/SECURITY.md`](https://github.com/vdung2k6-myna/adaptive-interview/blob/master/docs/SECURITY.md).

This document has two halves. **Deploying this safely** is what to set and what each setting
decides. **How each property is enforced** is the code path behind it, cited by file and symbol
rather than by pasted excerpt, because an excerpt is a copy that can silently disagree with the
file it came from.

## Deploying this safely

### The settings that decide your exposure

| Setting | What it decides |
|---|---|
| `API_AUTH_TOKEN` | Everything. **Unset means authentication is off, not that the service refuses to start.** |
| `MCP_ENABLED`, `MCP_AUTH_TOKEN` | Whether `/api/mcp` is reachable at all, and on what credential. |
| `FRONTEND_URL` | Which browser origins may call the API. A comma-separated allow-list. |
| `AUDIO_STORAGE_DIR` | Exactly which files `/audio` serves. Defaults to `/tmp/audio`. |
| `MUSIC_LIBRARY_DIR` | Optional. Must be inside `AUDIO_STORAGE_DIR` and must not be the root itself. |

**`API_AUTH_TOKEN` is fail-open.** `validateApiAuth` in `src/lib/auth.ts` returns `true` when the
variable is unset, and that single check is the whole of API authentication — it covers `/api/*`
and `/audio` alike. This is deliberate, and documented in the code as backward compatibility for
local development. The consequence is worth stating plainly: `.env.example` ships a placeholder
value, so an operator who never sets a real one gets a service that starts happily and serves
every candidate recording to anyone who asks. Unguessable is not authenticated.

One secret covers everything. There is no rotation, no per-client token, and no way to revoke one
caller without changing the value for all of them.

**`/api/mcp` has its own gate, and it is not `API_AUTH_TOKEN`.** `validateMcpAuth` in
`src/lib/mcp/auth.ts` refuses every request when `MCP_ENABLED` is not `true`, and when it is, treats
a `MCP_AUTH_TOKEN` that is missing **or shorter than 8 characters** as "auth disabled for local
dev". A four-character secret is not a weak secret here; it is no secret.

**`FRONTEND_URL` is an allow-list, and its failure mode is surprising.** A browser origin not on the
list does not receive a `403` — the CORS callback raises an error, which reaches the shared error
handler and comes back as a **`500`** with the rejected origin echoed in the body. A request
carrying no `Origin` header at all is always allowed, by design, for `curl` and native clients. The
allowed list is logged at boot.

**`AUDIO_STORAGE_DIR` is read in two places that must agree** — the mount built in `createApp()`
(`src/app.ts`) and `AUDIO_ROOT` in `src/lib/audio/storage.ts`. Both are read once, at import.

### What is reachable, and by whom

| Path | Gate |
|---|---|
| `GET /health` | None. Returns service status only; performs no retrieval or embedding. |
| `/audio/*` | The shared Bearer, via the middleware mounted inline on the static mount. |
| `/api/mcp` | Its own token. `API_AUTH_TOKEN` is never consulted for it. |
| `/api/*` | The shared Bearer, via `app.use("/api", apiAuthMiddleware)`. |
| Anything else | No route; `404` from the shared error handler. |

#### `/audio` is served behind the credential

It was not always. Until **2026-10-12** the mount sat ahead of the auth middleware and was reachable
from the internet by URL alone — measured against this deployment, whose ingress forwards `/audio`
as well as `/api` — which left every interview recording to the secrecy of two UUIDs. Unguessable is
not authenticated, and a URL leaks.

What the old arrangement was preserving had to go with it: a segment file swept at the end of a turn
used to answer `404` where a rejected credential answers `401`, so a person could tell a missing
recording from a forbidden one. For a recording, telling a caller who may not read these files which
URLs exist is not a courtesy. Behind the middleware, a request without a credential for a path
holding nothing is refused exactly as one holding a real recording is.

**The mount order this created is load-bearing, and the reason is not recoverable from the code
alone.** `/health` and `/api/mcp` are registered before `app.use("/api", apiAuthMiddleware)` so that
they stay reachable without a token. The audio mount is registered before it too, but does *not*
stay reachable: it wears the middleware itself rather than moving under `/api`, because its path is
stored verbatim in every `messages.audio_url` row and changing the path would owe a migration.

The rule to carry forward: **a public mount is public only for requests it answers itself**, and
`express.static` calls `next()` on a miss, so a request that falls through reaches whatever is
mounted after it. This is why the middleware is scoped to the `/api` prefix rather than mounted
bare — a bare `app.use(apiAuthMiddleware)` would answer a missing audio file with `401` and make an
absent file indistinguishable from a rejected credential. A public route added *after* the middleware
silently becomes authenticated, which is the safe direction to be wrong in.

## How each property is enforced

### Authentication

`apiAuthMiddleware` (`src/middleware/auth.ts`) delegates to `validateApiAuth` (`src/lib/auth.ts`),
which requires `Authorization: Bearer <token>` and compares it to `API_AUTH_TOKEN`. The comparison is
`===` — see Known gaps.

### Data access

All queries go through the Drizzle query builder via `db` (`src/lib/db.ts`). Raw SQL exists in
exactly two shapes, both parameterised:

- `db.execute(sql\`...\`)` in `getRequirementCoverage` (`src/lib/embeddings.ts`), binding
  `sessionId` and `positionId` as parameters and interpolating only `EMBED_DIMENSION`, a module
  constant.
- `IN (...)` fragments assembled with `sql.join` over bound parameter nodes, used for batch lookups
  in `src/routes/sessions.ts`, `src/routes/campaigns.ts` and `src/lib/mcp/tools/campaigns.ts`.

No user input is concatenated into SQL anywhere in the tree.

### Uploads

Two multer instances — `src/routes/voice.ts` and `src/routes/voice-agent.ts` — both configured with
`multer.memoryStorage()` and nothing else: no size limit, no file-count limit, no `fileFilter`, no
MIME allow-list. They guard `POST /api/voice/turn`, `POST /api/voice/stream` and
`POST /api/voice-agent/stream`. See Known gaps.

Where uploads land is decided by this service, not by multer. `saveAudio` (`src/lib/audio/storage.ts`)
writes to `{AUDIO_STORAGE_DIR}/{sessionId}/{uuid}-{prefix}.{ext}`. The filename is a fresh UUID and
the extension comes from a closed set derived from the part's media type, so no request value reaches
the path. `sessionId` — which does come from the request — is used in the path only after a database
lookup has returned a row for it, and the column is a `uuid` in the schema. The voice-agent path
never touches the audio root: it writes to a per-turn temporary directory that it removes.

### Outbound calls

Every outbound URL is read from configuration. No request field is ever used as a host or a URL. The
single request-supplied value that reaches an outbound call is a *model name*.

| Call | Endpoint source | Timeout |
|---|---|---|
| Embedding, chat, chat stream | `OLLAMA_BASE_URL` | Per-call, from config |
| Speech to text | `AUDIOCPP_BASE_URL` | Per-call, from config |
| Text to speech, voice catalog | `AUDIO_GATEWAY_URL` | Per-call, from config |
| Knowledge search | `DOC_ETL_API_URL` | Short, from config |

### Recordings at rest and in flight

Recordings live on the local filesystem under `AUDIO_STORAGE_DIR`, one directory per session, never
in the database and never in a session export. They are served by the `/audio` static mount behind
the shared credential, with the mount forcing a correct media type so that a container the
underlying `mime` table predates is still handed over as audio rather than as an opaque stream.

There is **no per-session or per-candidate authorization** on that mount: it is path-based, and any
holder of the one API token can read any recording whose path they hold. The path is two UUIDs, so
it is not guessable — but it is not scoped either. See Known gaps.

Streamed per-turn segment files are swept by age. Canonical interviewer recordings and candidate
uploads are durable and are not swept.

A music library, if configured, is served by the same mount, and is constrained to a directory inside
the audio root that is not the root itself — refused at read time, so a library cannot turn a
session's recordings, or a person's own voice, into tracks the model or a client can request.

## Known gaps

Each of these is current posture, not a to-do this document completes. They are listed because a
security document that enumerates only mitigations is the shape that lets a gap sit unnoticed. None
is fixed by the change that added this file; each wants a change of its own.

- **Authentication fails open.** `API_AUTH_TOKEN` unset leaves `/api/*` and `/audio` entirely
  unauthenticated — *wants its own change:* deciding whether the service should refuse to start
  without a token in production, and whether the unset case should be an explicit opt-in.
- **The MCP gate accepts a short token.** A `MCP_AUTH_TOKEN` under 8 characters reads as "auth
  disabled". *Wants its own change:* replacing a length heuristic with an explicit on/off setting.
- **No rate limiting**, on any route.
- **No upload size or count cap.** A caller holding the token can stream arbitrarily large audio into
  process memory on the voice routes, and `/api/voice/speak` accepts unbounded text to synthesize.
  *Wants its own change:* multer `limits` and a request body cap.
- **Error messages reach the client.** The shared error handler returns `err.message`, and several
  routes return it directly rather than falling through. For an Ollama failure that message carries
  the upstream service's response body. *Wants its own change:* an error shape that separates what
  the operator logs from what the caller is told.
- **`/api/voice-agent/stream` lets the caller set the system prompt.** `systemPrompt` and `tools` are
  taken from the request body and passed to the model; only non-emptiness is checked. Any holder of
  the shared token controls the model's instructions on that path.
- **A tool result is settled by turn id alone.** `/api/voice-agent/tool-result` matches a waiting turn
  on a `turnId:index` string with no session or caller binding, so a token-holder who knows a turn id
  can fabricate an outcome for someone else's turn.
- **The token comparison is not constant-time.** `===` in `src/lib/auth.ts` and `src/lib/mcp/auth.ts`.
- **One shared secret guards every recording.** There is no per-session authorization on the audio
  mount, so revocation is all-or-nothing. *Wants its own change:* scoping recordings to a session's
  own credential.
- **The default audio root is `/tmp/audio`** — a shared, predictable temporary directory, and one
  that does not exist by default on this project's Windows development host.

## Reporting

Report a suspected vulnerability privately to the repository maintainer rather than in a public
issue. Include the request that demonstrates it and what it exposes.

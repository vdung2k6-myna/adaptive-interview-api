# Capacity and Concurrency

What the voice pipeline can actually hold. Measured on 2026-10-20 against the live
services on the development host — not modelled, not extrapolated from vendor
numbers.

Three services decide the answer, and all three were probed at increasing
concurrency:

| service | endpoint | what runs there |
|---|---|---|
| STT | `http://127.0.0.1:8080` | audio.cpp, CUDA backend, `model=stt` |
| TTS | `http://127.0.0.1:8082` | Audio Gateway, piper, voice `bryce` |
| LLM | `http://127.0.0.1:11434` | `deepseek-v4.1-flash:cloud` via the local Ollama daemon |

The probes touched no candidate data. STT was given speech synthesized by the TTS
service (a fixed sentence repeated to 58 s); the LLM was given a synthetic
20-message history.

---

## Measured capacity

### STT — audio.cpp

58.1 s of 16 kHz mono WAV, `language=en`:

| concurrent requests | wall | per-request latency |
|---|---|---|
| 1 | 6.35 s | 6.35 s |
| 2 | 12.77 s | 6.38, 12.77 |
| 4 | 25.75 s | 6.44, 12.87, 19.32, 25.75 |

**~9.1x real-time, serialized.** Throughput stays flat at 9.0-9.2x while latency
scales linearly: requests queue behind one another. There is no parallelism to
buy by asking for more.

Re-measured later the same day on a 66.3 s input: 5.15 s, **12.9x**. The service was
not changed between the two runs; the lower figure is the conservative one used in
the arithmetic below.

A 90-second answer costs about 10 s of service time. Five people pressing stop
within a few seconds of each other put the fifth behind roughly 40 s of queue.

### TTS — Audio Gateway (piper)

One 8.5 s sentence (33 words):

| concurrent requests | wall | per-request latency |
|---|---|---|
| 1 | 0.37 s | 366 ms |
| 2 | 0.71 s | 361, 710 |
| 4 | 1.41 s | 364, 713, 1075, 1410 |
| 8 | 2.76 s | 366 ... 2761 |

**~23.3x real-time, also serialized.** Per turn the cost is small — about 18
chunks is 3 s of service occupancy — but the fan-out is not capped by the API, so
a reply boundary releases every pending chunk at once.

### LLM — Ollama cloud model

Prompt of 1,053 tokens (prefix cache reported 1,024 of them reused), 100 output
tokens, `stream: true`:

| concurrent | succeeded | first spoken token | stream total |
|---|---|---|---|
| 1 | 1/1 | 0.92 s | 1.18 s |
| 2 | 2/2 | 0.95, 1.73 | <= 1.90 s |
| 4 | 4/4 | <= 2.15 s | <= 2.31 s |
| 8 | 8/8 | <= 3.63 s | <= 3.81 s |
| 16 | **15/16** | median 2.99, max 5.58 | median 3.13 |
| 32 | **13/32** | median 3.99, max 6.23 | median 4.14 |

The wall is contractual, not computational. Past roughly 15 requests in flight,
the account answers immediately with:

```json
{"error": "too many concurrent requests"}
```

HTTP 429, no queueing. Between 13 and 15 requests were in flight successfully in
both the 16 and 32 runs, so the ceiling sits at about 15 per account.

Two details from the same probe:

- About two thirds of stream chunks were `thinking` rather than content at
  concurrency 1. The model reasons before it speaks, and first *spoken* token is
  still under a second.
- Prefix caching works: a repeated system prompt plus a shared history prefix was
  served from cache across runs.

### The voice-agent turn, end to end

Driven through the real route — `POST /api/voice-agent/stream` — rather than the
services beneath it. That route needs no session: history travels in the request
body and audio comes back inline as base64, so the probe touched no database and
wrote no files.

A 14.1 s answer, 19 messages of history, `language=english`, `engine=piper`.
Medians of three runs:

| variant | first `text` | turn total | audio produced |
|---|---|---|---|
| text input, muted | 0.99 s | 1.23 s | — |
| text input, spoken | 0.91 s | 1.38 s | 12.2 s |
| audio input, muted | 2.46 s | 2.63 s | — |
| audio input, spoken | 2.03 s | 2.71 s | 14.4 s |

Read as stage costs on the critical path:

```
LLM (generate to first spoken chunk)   ~1.0 s
STT (14.1 s answer, 9.1x real-time)    ~1.1-1.5 s
TTS (whole reply, 23.3x real-time)     ~0.1-0.2 s
```

TTS produces 14 s of speech but adds about a tenth of a second to the turn,
because it runs behind the LLM stream and finishes long before the reply does.
The route awaits each sentence's synthesis before reading the next token, but
synthesis is fast enough that the wait is milliseconds — it does **not** tie the
turn's duration to playback.

At concurrency:

| concurrent turns | succeeded | first `text` (min / median / max) | turn (min / median / max) |
|---|---|---|---|
| 1 | 1/1 | 2.97 / 2.97 / 2.97 | 3.58 / 3.58 / 3.58 |
| 2 | 2/2 | 2.18 / 3.27 / 3.27 | 2.85 / 3.71 / 3.71 |
| 4 | 4/4 | 2.07 / 4.96 / 5.28 | 2.57 / 5.35 / 6.10 |
| 8 | 8/8 | 2.26 / 6.43 / 9.72 | 2.77 / 7.19 / 10.26 |

All eight turns completed; the ~15-request LLM ceiling was not reached. The
spread is STT queueing: eight simultaneous answers at ~1.55 s of service time
each put the last turn roughly 10 s behind, which is what its first `text` shows.
The API's own overhead is small — the fastest turn in each batch starts within a
few hundred milliseconds of the single-turn figure.

Driven past the ceiling, nothing failed:

| concurrent turns | completed | wall | first `text` (min-max) |
|---|---|---|---|
| 16 | 16/16 | 18.8 s | 2.57-18.48 s |
| 24 | 24/24 | 28.0 s | 2.20-27.34 s |

**STT serialization is masking the LLM's concurrency cap.** The raw LLM probe hit
`429` at 16; the route at 16 and 24 produced no failures because turns reach the
model one at a time as transcription frees them, so more than ~15 are never in
flight at once. The cost lands in the tail instead: at 24 simultaneous answers,
the last person waits 27 s for the first word.

This interaction matters for the levers below. Making STT parallel (lever 1 or 2)
removes the queue *and* the accidental throttle; without a queue or a retry in
front of the model, the same burst would then start failing turns outright rather
than merely delaying them. The two should move together.

### After windowed ingestion

Measured on 2026-10-20 against the deployed stack with `NEXT_PUBLIC_WINDOWED_INGEST=true`:
an 11.5 s answer sent as two windows, then a turn that carried only the turn's id. The
same route, `POST /api/voice-agent/stream`.

| concurrent turns | completed | first `text` after submit (min / median / max) | window uploads finished (slowest flow) | wall |
|---|---|---|---|---|
| 1 | 1/1 | 1.43 s | 1.4 s | 2.95 s |
| 8 | 8/8 | 0.76 / 1.26 / 1.75 s | 8.5 s | 10.1 s |
| 16 | 16/16 | 0.67 / 0.83 / 1.65 s | 17.0 s | 18.3 s |
| 24 | 24/24 | 0.56 / 0.84 / 1.48 s | 25.5 s | 26.6 s |

The wait after pressing stop no longer contains transcription: in this run, at 24
concurrent turns it was 1.5 s at worst, against 27.3 s before. Every turn completed,
and the model's ceiling was still not reached — the windows reach it in sequence, just
as whole recordings did. The later re-measurement below shows how much of a tail is
the model's own queue rather than this path.

The upload column is the probe's worst case, not the product's. All 24 answers' windows
were sent at once, so they queued behind the serialized transcriber; in the client the
windows go out while the person is speaking, which is the point — by the time they stop,
the queue is empty. The earlier 14.1 s answer and this 11.5 s one differ, so compare the
shape of the wait rather than the two numbers exactly.

### Re-measured after the changes (same day, later)

The stack changed; the three services did not. Re-running both turn matrices with the same
answer lengths and the same route gave this — the whole-body answer 14.0 s, the windowed one
11.6 s in two windows:

| concurrent | whole-body completed | whole-body first `text` (min / median / max) |
|---|---|---|
| 1 | 1/1 | 8.83 s |
| 8 | 8/8 | 4.33 / 7.42 / 16.99 s |
| 16 | 16/16 | 4.89 / 12.70 / 21.97 s |
| 24 | 24/24 | 3.29 / 16.10 / 32.18 s |

| concurrent | windowed completed | windowed first `text` (min / median / max) | window uploads done |
|---|---|---|---|
| 1 | 1/1 | 1.11 s | 1.4 s |
| 8 | 8/8 | 0.73 / 0.90 / 1.10 s | 8.6 s |
| 16 | 16/16 | 0.84 / 1.48 / 15.14 s | 17.2 s |
| 24 | 24/24 | 0.70 / 18.28 / 39.34 s | 25.9 s |

**The difference is the model's queue, not the routes.** Probing the model directly, with the
API out of the path: first content was 0.92 s in the earlier run, and 9.07 s, 0.92 s and
16.7 s in three probes after this one. The provider's latency varies by more than an order of
magnitude within an hour. STT, meanwhile, measured 12.9x — faster than before.

So read the two end-to-end sections as the two ends of that variance, not as a before and
after. What the changes own is the shape: at 8 concurrent turns the windowed path is under a
second even in this run, the wait after stop never includes transcription, and every turn
completed in both tables — the retry turns a refusal into a wait instead of a failed turn. The
tails at 16 and 24 tracks the model's queue, which is what `OLLAMA_MAX_CONCURRENT_REQUESTS`
and the retry budget bound; raising them moves the queue upstream to the account's own 429.

---

## What a workload costs

Assumptions, stated so they can be corrected: a turn cycle of ~2.5 minutes (1.5
minutes of speech, ~1 minute listening and reading the reply), so a person is
mid-turn about 60% of the time; ~18 TTS chunks per reply; a 1.5-minute answer
uploaded at 32 kB/s (~2.9 MB).

100 concurrent interviews therefore produce roughly **0.7 turns/second**, or
2,400 turns/hour.

| resource | demand | measured capacity | processes needed |
|---|---|---|---|
| STT audio | ~63 s of audio per second | 9.1x per process | **7-8** |
| TTS speech | ~50 s of speech per second | 23.3x per process | **2-3** (more for bursts) |
| LLM streams | ~4 concurrent on average | ~15 concurrent before 429 | 1 account, with headroom |
| recordings on disk | ~7.2 GB/hour | — | retention policy, not capacity |

Read the table in that order. STT is the binding constraint by a wide margin;
TTS is next; the cloud LLM is comfortable on average and fails on bursts.

### At five concurrent interviews

Everything holds except STT. Five turns that align put ~50 s of audio through a
serialized 9x service, and the last person sits in silence with a spinner. TTS
clears a five-turn burst in ~16 s of service time, and the LLM sees at most five
concurrent streams.

### At 100 concurrent interviews

- **STT** needs a worker pool of 7-8 processes, or a move to something that
  batches. Whether one GPU can host that many audio.cpp instances is unmeasured.
- **TTS** needs 2-3 gateway workers, and the per-turn fan-out should be bounded
  first so the pool sees a queue rather than a spike.
- **LLM** is fine on average and breaks on bursts: without a retry, a burst past
  ~15 turns into failed turns rather than slow ones.
- **Disk** grows by ~7.2 GB/hour of recordings, before any retention policy.
- **The API process cannot be replicated as it stands.** Prefetch holds,
  tool-call waits and MCP transports are in-process maps, so a second instance
  would need sticky sessions or externalized state.

### At 100 voice-agent users

The voice agent is the same route, `POST /api/voice-agent/stream`, used two ways: the browser
page, which sends windows the way the interview page does, and the gadget through the bridge,
which still uploads one whole utterance per turn. The route is the cheapest turn path — no
session, no database, history carried in the request, synthesis serial by design — so what
bounds it is the turn rate and the services beneath, not the API.

An agent exchange is short. Assume a cycle of about 25 seconds (roughly 10 s of speech, 5 s
waiting, 8 s of reply) against the interview's 2.5 minutes.

| resource | interview at 100 | voice agent at 100 |
|---|---|---|
| turns per second | ~0.7 | **~4** |
| STT audio | ~63 s per second → 5-6 processes | ~40 s per second → **3-4 processes** |
| TTS speech | ~50 s per second → 3 workers | ~32 s per second → **2 workers** |
| model streams in flight | ~6 — under the ~15 ceiling | **~20 — over it** at normal model speed |
| API per turn | session, messages | **no database at all** |
| recordings on disk | ~7.2 GB/hour | **none stored** — the route is stateless |

The model ceiling is the first wall here, not the audio tier. At 0.7 turns/s the average sits
well below ~15; at 4 turns/s, a five-second stream puts about twenty in flight, so a share of
turns are refused and spend their retry budget waiting. Nothing fails — that is what the retry
is for — but the first word arrives later than it should. Shorter agent prompts generate
faster, which pushes the figure down; the estimate should be checked against the account.

**The bridge is a tier the interview path does not have.** For gadget users it holds one
device socket each — 24 kHz audio, VAD, Opus, one upload per turn — in a single Node service on
this machine. It has never been run above one device. Measure it with simulated devices before
any of the numbers above matter.

Two differences worth naming:

- **The gadget does not get the windowing improvement.** The bridge ends the turn itself and
  uploads the trimmed utterance, so its wait after speaking includes transcription — the
  whole-body profile. Streaming windows from the bridge would need a bridge and protocol
  change; the API's window endpoint cannot provide it alone.
- **No stored recordings on this route** means the 7.2 GB/hour disk wall does not apply. If
  most of the 100 users are gadget conversations, storage stops being the first constraint.

This profile is modelled from the route's measured turn costs, not from a 100-user run. What
would ground it: the bridge under simulated devices, and 20-30 simultaneous agent turns to see
where the refusal/retry trade-off actually lands with short prompts.

---

## Findings that came out of the probes

1. **`config.ollama.retries` is dead.** It is defined in both
   `src/lib/config/production.ts` and `development.ts` and read nowhere in `src/`.
   No call path retries, and the streaming routes have no retry of their own, so a
   429 fails the turn on the first attempt.
2. **The configured default piper voice is not held by the gateway.** The config
   default is `en_US-lessac-medium`; the gateway offers `bryce`,
   `en_US-norman-medium`, `fr_FR-tom-medium`, `vi_VN-vais1000-medium`. The live
   `.env` sets `PIPER_VOICE_ENGLISH=bryce`, so turns work — but a deployment
   without that override answers 502 for every English piper turn.
3. **Uploads are held whole in memory.** `multer.memoryStorage()` with no
   `limits` (`src/routes/voice.ts`, `src/routes/voice-agent.ts`), even though the
   file is written to disk immediately afterwards. At 100 turns in flight that is
   tens to hundreds of megabytes of transient RSS.
4. **TTS fan-out per turn is unbounded.** Both streaming routes schedule a
   synthesis per chunk and never cap in-flight work. `/api/voice/stream` does not
   drain the LLM stream; `/api/voice-agent/stream` does. Measured end to end, that
   second choice costs about a tenth of a second per turn — the await is on
   synthesis, not playback — so the risk is the fan-out, not the backpressure.
   The two routes still hold opposite policies for no stated reason.
5. **`/api/voice/stream` re-scans the whole reply per token**
   (`stripMarkdown`, `hasUnclosedCodeFence`, `splitSentences` over the accumulated
   text), while `/api/voice-agent/stream` uses an incremental extractor. One of
   the two is quadratic in reply length on the event loop.

---

## Levers, in order of payoff

1. **Take STT off the critical path.** Transcribe in windows while the answer is
   still being recorded, instead of the whole file after stop. This is the only
   change that improves both five and 100. It shares the capture pipeline with
   the client change that is already windowing audio for assembly.
2. **Scale the audio services.** 7-8 STT processes and 2-3 TTS processes at 100;
   the same change is what makes five stop queueing. Check first whether either
   service can batch internally rather than being run as N copies.
3. **Retry 429s with jitter and cap in-flight LLM requests at ~12.** Small and
   mechanical; turns the hard failure mode into a delay.
4. **Bound TTS per turn and unify the two routes' backpressure policy.**
5. **Stream uploads to disk instead of memory**, and decide a retention policy for
   recordings.

---

## Caveats

- Each cell is a single run except the 16 and 32 concurrency medians. Variance
  was not characterised.
- The host runs the entire stack (API, client, doc-etl, audio tier, Ollama
  daemon) on one machine; the audio services were idle apart from the probes.
- STT input was synthesized speech, repeated to length. Real spontaneous speech,
  and especially Vietnamese, may differ — Vietnamese also costs roughly 2.8x
  tokens per character, which lengthens prompts and replies and therefore shifts
  the LLM and TTS numbers.
- The gateway was measured on piper only. Kokoro and supertonic run different
  models and were not probed.
- The end-to-end probe stopped at 24 concurrent turns, and its replies were kept
  short (2-3 sentences) by the system prompt. A long reply costs more TTS
  occupancy in proportion — at 23.3x real-time, a 60 s spoken reply is ~2.6 s of
  service time rather than ~0.1 s.
- The 429 ceiling is account-level and may change with the provider's terms.

## Reproducing

```bash
# health
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8082/health
curl -s http://127.0.0.1:11434/api/ps

# STT: 16 kHz mono WAV, multipart
curl -s -X POST http://127.0.0.1:8080/v1/audio/transcriptions \
  -F "file=@answer.wav;type=audio/wav" -F model=stt -F language=en

# TTS
curl -s -X POST http://127.0.0.1:8082/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"text":"...","engine":"piper","voice":"bryce"}' -o out.wav

# LLM stream (measure time to first content chunk, not first byte)
curl -s -N http://127.0.0.1:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash:cloud","stream":true,"messages":[...],
       "options":{"num_predict":100}}'
```

Concurrency is the point: run each probe at N = 1, 2, 4, 8, 16, 32 and record
both per-request latency and aggregate throughput. A flat throughput line with
linear latency is a serialized service.

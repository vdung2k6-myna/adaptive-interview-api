import { Router, type Request, type Response } from "express";
import multer from "multer";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildVoiceAgentPrompt, trimVoiceAgentHistory, type VoiceAgentMessage } from "@/lib/prompts";
import { generateChatResponse, generateChatResponseStream } from "@/lib/ollama";
import { OllamaError } from "@/lib/errors";
import { searchKnowledge, type KnowledgeChunk, type KnowledgeSearch, type KnowledgeSearchOutcome } from "@/lib/knowledge";
import { MATERIAL_LOCATOR_TOP_K, resolveMaterialReply, selectMaterialHit } from "@/lib/material";
import { resolveAnswerMode, type AnswerMode } from "@/lib/personas";
import { createPrefetchStore, DEFAULT_PREFETCH_TOP_K, type PrefetchStore } from "@/lib/prefetch";
import { createSessionKnowledge, type SessionKnowledge } from "@/lib/session-knowledge";
import { resolveCollections } from "@/lib/topics";
import config from "@/lib/config";
import {
  transcribeAudio,
  synthesizeSpeechWithFallback,
  resolveVoice,
  resolveEngineForLanguage,
  hasUnclosedCodeFence,
  SentenceExtractor,
  SentenceStream,
  type SynthesizeOptions,
} from "@/lib/audio";

const upload = multer({ storage: multer.memoryStorage() });

/**
 * The collaborators this router calls out to, as parameters that default to the
 * real implementations. The route's own logic — which query it builds, which
 * scope it sends, which chunks reach the prompt — is then driven from a test
 * without a live doc-etl-api, ollama, or the audio services (design.md D10).
 */
export interface VoiceAgentDeps {
  searchKnowledge: KnowledgeSearch;
  transcribeAudio: typeof transcribeAudio;
  generateChatResponseStream: typeof generateChatResponseStream;
  generateChatResponse: typeof generateChatResponse;
  synthesizeSpeechWithFallback: typeof synthesizeSpeechWithFallback;
}

export function createVoiceAgentRouter(overrides: Partial<VoiceAgentDeps> = {}): Router {
  const deps: VoiceAgentDeps = {
    searchKnowledge,
    transcribeAudio,
    generateChatResponseStream,
    generateChatResponse,
    synthesizeSpeechWithFallback,
    ...overrides,
  };

  const router = Router();

  // One hold per router instance, searching through the injected collaborator so
  // a test can drive prefetch and reuse without the network (D1, D10).
  const prefetch = createPrefetchStore({ search: deps.searchKnowledge });

  // The session's one speculative fallback search, issued on a session's first
  // topical turn and never awaited (D4).
  const session = createSessionKnowledge({ search: deps.searchKnowledge });

  router.post("/stream", upload.single("audio"), (req, res) =>
    handleStream(req, res, deps, prefetch, session)
  );
  router.post("/prefetch", (req, res) => handlePrefetch(req, res, prefetch));
  return router;
}

/* ── SSE helper ─────────────────────────────────────────────────── */
function sendSseEvent(res: Response, event: string, data: unknown) {
  try {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(payload);
    (res as Response & { flush?: () => void }).flush?.();
  } catch {
    // Client may have disconnected
  }
}

function startHeartbeat(res: Response, intervalMs: number = 3000) {
  const timer = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
      (res as Response & { flush?: () => void }).flush?.();
    } catch {
      // Client may have disconnected
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

function getMaxHistory(): number {
  const env = process.env.VOICE_AGENT_MAX_HISTORY;
  if (!env) return 20;
  const parsed = parseInt(env, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? 20 : parsed;
}

function validateLanguage(value: unknown): "english" | "vietnamese" {
  if (value === "english" || value === "vietnamese") return value;
  return "english";
}

function validateEngine(value: unknown): "kokoro" | "piper" | "supertonic" {
  if (value === "kokoro" || value === "piper" || value === "supertonic") return value;
  return "kokoro";
}

function parseHistory(value: unknown): VoiceAgentMessage[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is VoiceAgentMessage =>
        m &&
        typeof m === "object" &&
        (m.role === "agent" || m.role === "user") &&
        typeof m.content === "string"
    );
  } catch {
    return [];
  }
}

function parseEnabledTopics(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // fall through
    }
  }
  return [];
}

interface RequestTopics {
  /** Names to scope a search to. Empty when no label survived the fold. */
  collections: string[];
  /**
   * The enabled labels that resolved, joined — the query for the session's
   * topic-scoped search, which has no user input to search for (4.3). Labels
   * dropped by the fold are left out: they name nothing the corpus serves, so
   * they would only bias the ranking toward a topic with no chunks.
   */
  query: string;
}

/**
 * Resolve a request's `enabledTopics` to the collections that scope its search,
 * logging any label that folded to no name. Read by both the turn and the
 * prefetch route so a prefetch is scoped exactly as the turn it serves will be —
 * a mismatch there would hold chunks the turn could never reuse.
 */
function resolveRequestTopics(body: { enabledTopics?: unknown }): RequestTopics {
  const labels = parseEnabledTopics(body.enabledTopics);
  const { collections, dropped } = resolveCollections(labels);
  if (dropped.length) {
    console.warn(
      `[VoiceAgent] Dropped ${dropped.length} topic label(s) folding to no collection name:`,
      dropped
    );
  }
  return {
    collections,
    query: labels.filter((label) => !dropped.includes(label)).join(" "),
  };
}

/**
 * Whether a held prefetch can serve as a material turn's locator.
 *
 * The gate itself, asked before the turn is answered rather than after: a
 * material turn's reply is the section of an eligible hit, so a hold whose hits
 * the gate would refuse cannot locate one — and a prefetch issued for the
 * generating path asked for no section, so this is the ordinary answer for one
 * (design.md D6). It reads the same speakable set and floor the reply will be
 * decided by, so the two questions cannot disagree.
 */
function canLocateMaterial(chunks: KnowledgeChunk[], answerMode: AnswerMode): boolean {
  return selectMaterialHit({
    outcome: { ok: true, chunks },
    answerMode,
    policy: config.material,
  }).ok;
}

/**
 * Save uploaded audio to a temp file for STT, then clean it up.
 */
async function withTempAudioFile(buffer: Buffer, ext: string, fn: (path: string) => Promise<void>) {
  const tmpDir = await mkdtemp(join(tmpdir(), "voice-agent-"));
  const tmpPath = join(tmpDir, `audio.${ext}`);
  try {
    await writeFile(tmpPath, buffer);
    await fn(tmpPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ── POST /api/voice-agent/stream ───────────────────────────────── */

async function handleStream(
  req: Request,
  res: Response,
  deps: VoiceAgentDeps,
  prefetch: PrefetchStore,
  session: SessionKnowledge
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      abortController.abort();
      cleanupHeartbeat();
    }
  };
  res.on("close", onDisconnect);

  let stopHeartbeat: (() => void) | null = null;
  const cleanupHeartbeat = () => {
    if (stopHeartbeat) {
      stopHeartbeat();
      stopHeartbeat = null;
    }
  };

  // Keep the connection warm across the turn's silent stretches — transcription,
  // the knowledge search, and the wait for the LLM's first token. A proxy or the
  // browser drops an idle stream (the client sees ERR_QUIC_PROTOCOL_ERROR), so a
  // comment byte every few seconds holds it open until the first `text` arrives.
  stopHeartbeat = startHeartbeat(res);

  try {
    const language = validateLanguage(req.body.language);
    const requestedEngine = validateEngine(req.body.engine);
    const engine = resolveEngineForLanguage(requestedEngine, language);
    const systemPrompt = typeof req.body.systemPrompt === "string" ? req.body.systemPrompt : "";
    const rawHistory = parseHistory(req.body.history);
    const audioFile = req.file;
    const textInput = typeof req.body.text === "string" ? req.body.text.trim() : "";
    // A client that will not play this turn's audio says so up front. The turn is
    // then transcribed, grounded and streamed exactly as it would be — every
    // `sentence` event keeps its index and its text, with `audioData: null` where
    // the audio would have been, which is the shape D4 already emits for a chunk
    // whose synthesis failed. Synthesis is the expensive half of a turn and the
    // bulk of what reaches the wire, so skipping it is the whole point: a muted
    // client pays neither. Absent, or anything but "0", means speak — a form
    // field nobody sends is a field no older client can be broken by.
    const speak = req.body.speak !== "0";

    // The persona's preference, as the client read it from the catalog it loaded:
    // a persona is served with its answer mode, and a turn carries back the one
    // its session was started as. Folded by the same function the catalog folds a
    // stored row with, so a client that predates the capability — or one running
    // on its built-in fallback list — generates, exactly as it does today.
    //
    // What a client can do with this is bounded on purpose: it chooses only
    // whether this turn *tries* to read the material, and the speakable set and
    // the floor that decide whether it succeeds are server config no request
    // field can reach (design.md D3, D5).
    const answerMode = resolveAnswerMode(req.body.answerMode);
    const isMaterialTurn = answerMode === "material";

    if (!systemPrompt) {
      sendSseEvent(res, "error", { message: "systemPrompt is required" });
      res.end();
      return;
    }

    // The enabled topics scope every search this session issues, and they are
    // known before transcription: resolving them here is what lets the session's
    // topic-scoped search start *concurrently* with it rather than after it. The
    // turn's own search below reads these same values.
    const { collections, query: topicQuery } = resolveRequestTopics(req.body);

    // A session's first turn carrying topics issues the session's one
    // topic-scoped search, and never awaits it (D4, 4.1, 4.2). `history` is empty
    // on that turn and non-empty on every later one, which is the only session
    // boundary the wire carries.
    if (!rawHistory.length && collections.length) {
      if (session.ensure(collections, topicQuery)) {
        console.log(
          `[VoiceAgent] Session topic-scoped search issued for "${topicQuery}" ` +
            `scoped to [${collections.join(", ")}]`
        );
      }
    }

    let userText = "";
    if (audioFile) {
      const audioExt = audioFile.mimetype === "audio/wav" ? "wav" : "webm";
      await withTempAudioFile(audioFile.buffer, audioExt, async (tmpPath) => {
        const sttResult = await deps.transcribeAudio(tmpPath);
        userText = sttResult.text;
      });
    } else if (textInput) {
      userText = textInput;
    }

    // Audio that transcribed to nothing is not a failure and not a turn: there is
    // nothing to ground, answer or speak, and letting it through would hand the LLM
    // its own history with no new user turn — the agent would answer the previous
    // question again. Ending here instead is deliberate, and is why the guard names
    // audio: an empty `userText` is legitimate on the opening turn, which carries no
    // audio and no text at all and must still reach the LLM to say hello.
    if (audioFile && !userText) {
      console.log("[VoiceAgent] Transcription was empty; the turn ends with nothing heard");
      // A `notice`, not an `error`: nothing went wrong, and the client shows this
      // as an inline remark rather than a failure. The code is what the client
      // translates and the message is what it falls back to for a code it does not
      // know, so the wire stays self-describing either way.
      sendSseEvent(res, "notice", {
        code: "no_speech",
        message: "No speech detected. Please try again.",
      });
      res.end();
      return;
    }

    // Build the full history for display, then trim for the LLM context.
    const displayHistory: VoiceAgentMessage[] = [...rawHistory];
    if (userText) {
      displayHistory.push({ role: "user", content: userText });
      sendSseEvent(res, "user", { text: userText, messageId: `user-${Date.now()}` });
    }

    const llmHistory = trimVoiceAgentHistory(displayHistory, getMaxHistory());

    // Knowledge retrieval: the enabled topics scope the search, and the query is
    // the user's own input — so a prefetch of this text and its submission are
    // one query (D3), which is what D2 can compare. The scope itself was resolved
    // above, before transcription.
    // An input is trimmed once at this boundary and once at the prefetch route's,
    // identically, so the two sides compare as the same text. The comparison
    // itself stays exact: a prefetch is the turn's knowledge only for the input it
    // was issued for (D2).
    const prefetchId = typeof req.body.prefetchId === "string" ? req.body.prefetchId : "";

    let knowledgeChunks: KnowledgeChunk[] = [];
    let reusedPrefetch = false;
    // What a material turn's gate is given. Null means the turn has nothing to
    // gate on — no search was issued, or the one it issued failed — which is a
    // turn to generate rather than a turn to refuse (lib/material.ts).
    let locatorOutcome: KnowledgeSearchOutcome | null = null;

    if (prefetchId && userText) {
      const claimed = prefetch.claim(prefetchId, userText);
      if (claimed !== null) {
        // The prefetch is the turn's knowledge for this input, so it replaces the
        // turn's own search rather than adding to it (D1). An empty claim counts:
        // it is an answer, and searching again would ask the same question twice.
        knowledgeChunks = claimed;
        reusedPrefetch = true;
        // A material turn's reply *is* its search's result, so a hold can locate
        // the turn only if it carries a hit the gate would pass — and a prefetch
        // issued for the generating path was asked for no section, so its hits
        // cannot be spoken (design.md D6). Reusing one regardless would turn a
        // material turn into a generated one merely because a prefetch happened
        // to be held, which is exactly the "never worse off" property the
        // fallback requirement states; so the hold is declined and the turn
        // issues the single locator search it would have issued with no prefetch
        // held. The gate is a pure function and is asked twice on this path, once
        // to decide this and once to answer the turn.
        locatorOutcome = { ok: true, chunks: claimed };
        if (isMaterialTurn && !canLocateMaterial(claimed, answerMode)) {
          locatorOutcome = null;
          reusedPrefetch = false;
          console.log(
            "[VoiceAgent] Prefetched knowledge carries no section a material turn can speak; " +
              "issuing the locator search instead"
          );
        } else {
          console.log(
            `[VoiceAgent] Reused prefetched knowledge: ${claimed.length} chunk(s), no search issued`
          );
        }
      } else {
        console.log(
          "[VoiceAgent] Prefetch did not match this turn's input; discarding it and searching fresh"
        );
      }
    }

    if (!reusedPrefetch && collections.length && userText) {
      // A material turn's search locates rather than supplies context, so it asks
      // for a single result: the hit is wanted for its address, its position and
      // its own gate fields, and nothing else off it is read (D1).
      const topK = isMaterialTurn ? MATERIAL_LOCATOR_TOP_K : DEFAULT_PREFETCH_TOP_K;
      console.log(
        `[VoiceAgent] Knowledge query: "${userText}" scoped to [${collections.join(", ")}]` +
          (isMaterialTurn ? ` — locator, ${topK} result` : "")
      );
      // A material turn's search locates and must expand: the reply is the hit's
      // whole section, so the passage has to come back with the hit rather than
      // be fetched afterwards (D1). A generating turn asks for none, which keeps
      // its request body byte-identical to what it was before this capability
      // (design.md D5, D6).
      const outcome = await deps.searchKnowledge(
        userText,
        topK,
        collections,
        isMaterialTurn ? { expand: "section" } : undefined
      );
      if (outcome.ok) {
        knowledgeChunks = outcome.chunks;
        locatorOutcome = outcome;
        if (knowledgeChunks.length) {
          console.log(
            `[VoiceAgent] Retrieved ${knowledgeChunks.length} knowledge chunk(s)`
          );
        }
      } else if (outcome.reason === "rejected") {
        // D9: the service refused a request this backend built. Answering that
        // with the session's chunks would render our own defect as a slightly-off
        // success, so a refusal draws on nothing.
        console.warn(
          "[VoiceAgent] Search refused by doc-etl-api; not drawing on the session's " +
            "topic-scoped chunks for this turn"
        );
      } else {
        // D4: the session's topic-scoped search exists for exactly this turn's
        // failure — a search that failed to obtain a result. A turn whose own
        // search succeeded never reaches here, so the fallback is a fallback and
        // not a second source (4.5), and one whose scope differs gets nothing
        // (4.6).
        knowledgeChunks = session.chunksFor(collections);
        if (knowledgeChunks.length) {
          console.log(
            `[VoiceAgent] Turn search ${outcome.reason}; using ${knowledgeChunks.length} ` +
              "session topic-scoped chunk(s)"
          );
        } else {
          console.log(
            `[VoiceAgent] Turn search ${outcome.reason}; no session topic-scoped ` +
              `chunks held for [${collections.join(", ")}]`
          );
        }
      }
    }

    const ttsOptions: SynthesizeOptions = {
      engine,
      voice: resolveVoice(engine, language),
      signal: abortController.signal,
    };

    // One stream, one sink, for both emit sites: the read loop below and the
    // `finalize` tail after it. That is what keeps the chunk index unbroken
    // across them (D3) — the index used to live in a route-level counter that
    // both sites incremented. This route is the caller that discovers its
    // sentences one at a time, so each is pushed as it is extracted.
    const sentenceStream = new SentenceStream({
      // A muted turn answers every chunk with no audio rather than not answering
      // at all: the stream still walks every chunk, so the indices, the texts and
      // the `flush()` the tail waits on are the same as a spoken turn's.
      synthesize: speak
        ? (chunk) =>
            deps.synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal)
        : async () => null,
      signal: abortController.signal,
      // This route's transport guard checks the signal only, where speak-stream
      // also checks `res.writableEnded`; the guard stays in each caller's sink so
      // both are preserved exactly as they were (D5).
      onChunk: ({ index, text, buffer }) => {
        if (abortController.signal.aborted) return;
        sendSseEvent(res, "sentence", {
          index,
          text,
          audioData: buffer ? buffer.toString("base64") : null,
        });
      },
      // A failed chunk is emitted as null audio at its own index and the turn
      // goes on (D4); this only reports it. An abort is not a failure and never
      // reaches here.
      onError: (err, { index }) => {
        console.error(`[VoiceAgent] TTS failed chunk ${index}:`, err);
      },
    });

    const extractor = new SentenceExtractor({
      shouldSkip: hasUnclosedCodeFence,
    });

    // The material attempt: the gate, then the passage (design.md D1, D3, D4).
    // It runs only for a persona that declared material replies, which is what
    // keeps a generating turn's cost and shape exactly as they were; for those
    // turns the path does not exist rather than being taken and abandoned. It
    // reaches no service: the passage arrived with the locator's search.
    const material = isMaterialTurn
      ? await resolveMaterialReply({
          outcome: locatorOutcome,
          answerMode,
          policy: config.material,
        })
      : null;

    if (material && !material.ok) {
      // Every way the material path can fail lands here, and generating is what
      // answers each of them: a turn is never worse off than it was before this
      // capability existed (design.md D3).
      console.log(
        `[VoiceAgent] Material path did not answer this turn (${material.reason}); generating instead`
      );
    }

    let tokenCount = 0;
    let finalText: string;

    try {
      if (material?.ok) {
        // No model is asked for this turn at all, and no prompt is built for it:
        // a material turn has none, because the corpus is the answer (D1).
        //
        // The reply is already whole, so it goes to `finalize` rather than through
        // the extractor token by token — the same sink the generated path's tail
        // goes to, which is what makes the client's events for the turn identical
        // to a generated turn's (D7). `finalize` is the extractor's own answer for
        // text that stops being streamed, and it salvages a trailing fragment the
        // per-token path would drop, which a stored chunk can end on.
        cleanupHeartbeat();
        finalText = material.text;
        console.log(
          `[VoiceAgent] Material reply: read ${finalText.length} char(s) from ` +
            `${JSON.stringify(material.hit.source)} at position ${material.hit.position} ` +
            `(score ${material.hit.score}) — no model requested`
        );
      } else {
        const prompt = buildVoiceAgentPrompt(
          systemPrompt,
          language,
          llmHistory,
          knowledgeChunks.length ? knowledgeChunks : undefined
        );

        const { stream: llmStream, getFullText } = deps.generateChatResponseStream({
          messages: prompt,
          temperature: 0.7,
          repeat_penalty: 1.2,
        });

        const reader = llmStream.getReader();
        let streamEmpty = true;

        while (true) {
          if (abortController.signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;

          const token = typeof value === "string" ? value : "";
          if (!token) continue;
          streamEmpty = false;
          tokenCount++;
          if (tokenCount <= 5 || tokenCount % 10 === 0) {
            console.log(`[VoiceAgent] LLM token ${tokenCount}: "${token.replace(/\n/g, "\\n")}"`);
          }

          const sentences = extractor.feed(token);
          for (const { clean, chunks } of sentences) {
            if (abortController.signal.aborted) break;
            // Emit text immediately so the frontend can render it even if TTS
            // is slow or fails. The matching `sentence` event (with audio) will
            // follow when synthesis completes.
            // Content is flowing now, so the heartbeat has done its job: every
            // later gap is between two `text`/`sentence` events, not a silence.
            cleanupHeartbeat();
            sendSseEvent(res, "text", { text: clean });
            console.log(`[VoiceAgent] TTS sentence scheduled: "${clean.substring(0, 80)}" → ${chunks.length} chunk(s)`);
            // Awaited, so the read loop still stalls between tokens while the
            // sentence is spoken — which is what this route did before the move,
            // and what keeps each sentence's chunks ahead of the next `text`
            // event (D2). The core splits and indexes it (D6, D3).
            await sentenceStream.push(clean);
          }
        }

        // Some cloud models (e.g. kimi-k2.6:cloud) stream with empty content
        // but return full text in non-streaming mode. Fall back when streaming
        // yielded nothing.
        finalText = getFullText();
        if (streamEmpty || !finalText.trim()) {
          console.log("[VoiceAgent] Streaming yielded no text; falling back to non-streaming generateChatResponse");
          finalText = await deps.generateChatResponse({ messages: prompt, temperature: 0.7, repeat_penalty: 1.2 });
        }
      }

      const tailSentences = extractor.finalize(finalText);
      for (const { clean, chunks } of tailSentences) {
        if (abortController.signal.aborted) break;
        sendSseEvent(res, "text", { text: clean });
        console.log(`[VoiceAgent] TTS sentence scheduled: "${clean.substring(0, 80)}" → ${chunks.length} chunk(s)`);
        await sentenceStream.push(clean);
      }

      // Before `done`, so the client is never told the turn ended while audio
      // for it is still arriving (D1).
      await sentenceStream.flush();

      console.log(
        material?.ok
          ? `[VoiceAgent] Material turn done. ${finalText.length} char(s), no model requested`
          : `[VoiceAgent] LLM done. Tokens: ${tokenCount}, finalText length: ${finalText.length}`
      );

      if (!abortController.signal.aborted) {
        sendSseEvent(res, "done", {
          messageId: `agent-${Date.now()}`,
          fullText: finalText,
        });
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        return;
      }
      console.error("[VoiceAgent] Streaming error:", err);
      const message = err instanceof OllamaError ? err.message : "Failed to generate response";
      sendSseEvent(res, "error", { message });
    } finally {
      cleanupHeartbeat();
      res.end();
    }
  } catch (err) {
    console.error("[VoiceAgent] Unexpected error:", err);
    if (!res.writableEnded) {
      sendSseEvent(res, "error", {
        message: err instanceof Error ? err.message : "Unexpected error",
      });
      res.end();
    }
  } finally {
    // Also covers the early return on a missing systemPrompt, which leaves
    // before the streaming block's own finally.
    cleanupHeartbeat();
  }
}

/* ── POST /api/voice-agent/prefetch ─────────────────────────────── */

/**
 * Search for a text turn that has not been submitted yet and hold the result
 * under a single-use id, so the turn that submits that text can skip its search.
 *
 * The response is `{ prefetchId }` with `prefetchId: null` whenever there is
 * nothing to reuse — no input, no topic resolving to a collection, or a search
 * that did not yield a result. A declined prefetch is an ordinary answer, not an
 * error: the turn it was meant for then searches exactly as it would with no
 * prefetch held (D5, D9).
 */
async function handlePrefetch(
  req: Request,
  res: Response,
  prefetch: PrefetchStore
): Promise<void> {
  try {
    // Trimmed exactly as the submitting turn trims its input, so the text the
    // hold is issued for is the text the claim will compare against (D2).
    const input = typeof req.body.text === "string" ? req.body.text.trim() : "";
    const { collections } = resolveRequestTopics(req.body);

    if (!input || !collections.length) {
      console.log(
        `[VoiceAgent] No prefetch issued: ${!input ? "no input" : "no topic resolving to a collection"}`
      );
      res.json({ prefetchId: null });
      return;
    }

    // A prefetch is issued before the turn, so the persona that will submit it is
    // the one fact this route cannot derive: `answerMode` is how the client says
    // it. Omitting it is valid and is the generating path's own request — the
    // hold then carries no section, and a material turn that claims it declines
    // the hold and issues its own locator search (design.md D6).
    const answerMode = resolveAnswerMode(req.body.answerMode);
    const expand = answerMode === "material" ? ({ expand: "section" } as const) : undefined;

    console.log(
      `[VoiceAgent] Prefetching knowledge for "${input}" scoped to [${collections.join(", ")}]` +
        (expand ? " — with each hit's section" : "")
    );
    const prefetchId = await prefetch.issue(input, collections, expand);
    if (!prefetchId) {
      console.log("[VoiceAgent] Prefetch held nothing: the search did not yield a result");
    }

    res.json({ prefetchId });
  } catch (err) {
    // A prefetch is speculative. It must never be the reason a turn cannot be
    // submitted, so every failure reads to the client as "nothing to reuse".
    console.error("[VoiceAgent] Prefetch failed:", err);
    if (!res.headersSent) {
      res.json({ prefetchId: null });
    }
  }
}

const router = createVoiceAgentRouter();

export default router;
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildVoiceAgentPrompt, trimVoiceAgentHistory, type VoiceAgentMessage } from "@/lib/prompts";
import { generateChatResponse, generateChatResponseStream } from "@/lib/ollama";
import { OllamaError } from "@/lib/errors";
import { searchKnowledge, type KnowledgeChunk, type KnowledgeSearch } from "@/lib/knowledge";
import { createPrefetchStore, type PrefetchStore } from "@/lib/prefetch";
import { createSessionKnowledge, type SessionKnowledge } from "@/lib/session-knowledge";
import { resolveCollections } from "@/lib/topics";
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
    }
  };
  res.on("close", onDisconnect);

  try {
    const language = validateLanguage(req.body.language);
    const requestedEngine = validateEngine(req.body.engine);
    const engine = resolveEngineForLanguage(requestedEngine, language);
    const systemPrompt = typeof req.body.systemPrompt === "string" ? req.body.systemPrompt : "";
    const rawHistory = parseHistory(req.body.history);
    const audioFile = req.file;
    const textInput = typeof req.body.text === "string" ? req.body.text.trim() : "";

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

    if (prefetchId && userText) {
      const claimed = prefetch.claim(prefetchId, userText);
      if (claimed !== null) {
        // The prefetch is the turn's knowledge for this input, so it replaces the
        // turn's own search rather than adding to it (D1). An empty claim counts:
        // it is an answer, and searching again would ask the same question twice.
        knowledgeChunks = claimed;
        reusedPrefetch = true;
        console.log(
          `[VoiceAgent] Reused prefetched knowledge: ${claimed.length} chunk(s), no search issued`
        );
      } else {
        console.log(
          "[VoiceAgent] Prefetch did not match this turn's input; discarding it and searching fresh"
        );
      }
    }

    if (!reusedPrefetch && collections.length && userText) {
      console.log(
        `[VoiceAgent] Knowledge query: "${userText}" scoped to [${collections.join(", ")}]`
      );
      const outcome = await deps.searchKnowledge(userText, 3, collections);
      if (outcome.ok) {
        knowledgeChunks = outcome.chunks;
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

    const prompt = buildVoiceAgentPrompt(
      systemPrompt,
      language,
      llmHistory,
      knowledgeChunks.length ? knowledgeChunks : undefined
    );

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
      synthesize: (chunk) =>
        deps.synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal),
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

    const { stream: llmStream, getFullText } = deps.generateChatResponseStream({
      messages: prompt,
      temperature: 0.7,
      repeat_penalty: 1.2,
    });

    const extractor = new SentenceExtractor({
      shouldSkip: hasUnclosedCodeFence,
    });

    const reader = llmStream.getReader();
    let tokenCount = 0;
    let streamEmpty = true;

    try {
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
      let finalText = getFullText();
      if (streamEmpty || !finalText.trim()) {
        console.log("[VoiceAgent] Streaming yielded no text; falling back to non-streaming generateChatResponse");
        finalText = await deps.generateChatResponse({ messages: prompt, temperature: 0.7, repeat_penalty: 1.2 });
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

      console.log(`[VoiceAgent] LLM done. Tokens: ${tokenCount}, finalText length: ${finalText.length}`);

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

    console.log(
      `[VoiceAgent] Prefetching knowledge for "${input}" scoped to [${collections.join(", ")}]`
    );
    const prefetchId = await prefetch.issue(input, collections);
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
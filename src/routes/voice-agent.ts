import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { audioUpload, discardUpload } from "@/lib/upload";
import {
  readTurnId,
  turnTranscripts,
  type TurnTranscriptStore,
} from "@/lib/turn-transcript";
import { buildVoiceAgentPrompt, trimVoiceAgentHistory, type VoiceAgentMessage } from "@/lib/prompts";
import {
  generateChatResponse,
  generateChatResponseStream,
  parseGadgetTools,
  type OllamaTool,
  type OllamaToolCall,
} from "@/lib/ollama";
import { OllamaError } from "@/lib/errors";
import { searchKnowledge, type KnowledgeChunk, type KnowledgeSearch, type KnowledgeSearchOutcome } from "@/lib/knowledge";
import { MATERIAL_LOCATOR_TOP_K, resolveMaterialReply, selectMaterialHit } from "@/lib/material";
import { resolveAnswerMode, type AnswerMode } from "@/lib/personas";
import { createPrefetchStore, DEFAULT_PREFETCH_TOP_K, type PrefetchStore } from "@/lib/prefetch";
import { createSessionKnowledge, type SessionKnowledge } from "@/lib/session-knowledge";
import { createToolCallStore, type ToolCallOutcome, type ToolCallStore } from "@/lib/tool-calls";
import { resolveCollections } from "@/lib/topics";
import { readLibrary, type Track } from "@/lib/music";
import config from "@/lib/config";
import {
  transcribeAudio,
  synthesizeSpeechWithFallback,
  resolveVoice,
  resolveEngineForLanguage,
  resolveSttLanguage,
  hasUnclosedCodeFence,
  SentenceExtractor,
  SentenceStream,
  type SynthesizeOptions,
} from "@/lib/audio";

// The body is written to disk as it arrives; see `lib/upload.ts` for why, and
// for the sweep that reclaims one nothing consumed.
const upload = audioUpload;

/**
 * The two tools this platform answers itself, named under a prefix of its own.
 *
 * The prefix is not decoration: the model is handed one list in which every entry is answered by a
 * different party, and the name is the only thing that says which — `self.*` is the gadget's,
 * `bridge.*` the bridge's, and these are the server's own.
 */
const LIST_MUSIC_TOOL = "platform.list_music";
const PLAY_MUSIC_TOOL = "platform.play_music";

/**
 * The library as the model is offered it: one line per track, numbered from one.
 *
 * The number is what a track is asked for by (design D4). The names beside them are what lets the
 * model recognise the track a person meant, and they are the library's own — the file's name without
 * its extension — because this service invents no name for a deployment's music.
 */
function shelfAnswer(tracks: readonly Track[]): string {
  return (
    "the tracks this platform holds, by number:\n" +
    tracks.map((track, at) => `${at + 1}. ${track.title}`).join("\n")
  );
}

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
  /**
   * Where this deployment's music library is, or empty for one that has none.
   *
   * Injected rather than read from config where it is used, for the reason the four above are
   * (D10): a test can then offer a library of its own, and `config` is read once at import, so a
   * route that reached for it could only ever be tested against whatever the machine happened to
   * have configured. The default below is that same config value.
   */
  libraryDir: string;
}

export function createVoiceAgentRouter(overrides: Partial<VoiceAgentDeps> = {}): Router {
  const deps: VoiceAgentDeps = {
    searchKnowledge,
    transcribeAudio,
    generateChatResponseStream,
    generateChatResponse,
    synthesizeSpeechWithFallback,
    libraryDir: config.music.libraryDir,
    ...overrides,
  };

  const router = Router();

  // One hold per router instance, searching through the injected collaborator so
  // a test can drive prefetch and reuse without the network (D1, D10).
  const prefetch = createPrefetchStore({ search: deps.searchKnowledge });

  // The session's one speculative fallback search, issued on a session's first
  // topical turn and never awaited (D4).
  const session = createSessionKnowledge({ search: deps.searchKnowledge });

  // The turns that have asked a model, been answered with a call, and are now waiting to be
  // told what the gadget did about it. One registry per router instance, like the holds above.
  const toolCalls = createToolCallStore();

  // The windows a turn's client sent while the answer was being recorded: the
  // process's buffer, because they arrive on the voice route's `/window`.
  router.post("/stream", upload.single("audio"), (req, res) =>
    handleStream(req, res, deps, prefetch, session, toolCalls, turnTranscripts)
  );
  router.post("/prefetch", (req, res) => handlePrefetch(req, res, prefetch));

  // Where the bridge reports back what a gadget did. It is the only caller that can reach a
  // gadget at all — the tool channel lives inside the device's own socket — so it is the only
  // caller that ever has anything to say here.
  router.post("/tool-result", (req, res) => handleToolResult(req, res, toolCalls));
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

/**
 * An engine the caller actually asked for, or `undefined` when it named none.
 *
 * Returning a concrete engine here made "no choice" mean Kokoro, which then
 * overrode the language mapping: an English turn with no engine was synthesized
 * by Kokoro, which holds no English voice. `resolveEngineForLanguage` is the
 * one place that decides the fallback (Piper for English, Kokoro for
 * Vietnamese); this function must not pre-empt it.
 */
function validateEngine(
  value: unknown
): "kokoro" | "piper" | "supertonic" | undefined {
  if (value === "kokoro" || value === "piper" || value === "supertonic") return value;
  return undefined;
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


/* ── POST /api/voice-agent/stream ───────────────────────────────── */

async function handleStream(
  req: Request,
  res: Response,
  deps: VoiceAgentDeps,
  prefetch: PrefetchStore,
  session: SessionKnowledge,
  toolCalls: ToolCallStore,
  transcripts: TurnTranscriptStore
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
    // What the gadget says it can be asked to do, carried by the bridge with the turn and
    // already the gadget's own words. Empty for every client that is not a gadget — the
    // browser sends nothing here — and an empty list is what leaves the model asked with no
    // tools, exactly as every turn was before this existed.
    const gadgetTools = parseGadgetTools(
      typeof req.body.tools === "string" ? req.body.tools : undefined
    );
    // The tools this platform answers itself, offered only where the deployment holds music.
    //
    // Unlike a gadget's, these are **not** pushed out to whoever is on the connection: the library
    // is this service's, so there is nobody else to answer for it, and a round trip to a page and
    // back would be a trip for data the platform already has in hand. The prefix is the model's
    // own way of seeing which party answers a name — `self.*` the gadget's, `bridge.*` the
    // bridge's, these the platform's, which is the one list where every answer comes from the
    // server the model is talking to.
    //
    // Withheld from a turn that carries a gadget's own tools.
    //
    // A chosen track leaves this service as a `music` event on the turn's stream, and that event is
    // read by whoever made the request — on a device turn, the bridge. The bridge does not model the
    // event and drops it, deliberately, in the fall-through every unmodelled event takes. So a
    // `platform.*` call would be answered here, announced to the model as playing, said aloud by the
    // reply, and heard nowhere: the only music tool that reaches a device's speaker is the bridge's
    // own. Offering one that cannot be made to sound is worse than withholding it — the model
    // cannot tell before it calls, and a refusal would spend one of `toolCalls.maxRounds` on it.
    //
    // That `gadgetTools` identifies a device turn is a **proxy** and not the fact: it is non-empty
    // because the bridge ships the gadget's catalogue with every turn the gadget completed a
    // handshake for. A bridge whose catalogue read failed, and which holds no music of its own,
    // carries no `tools` field — and is offered these again. A field by which a caller states where
    // its audio can be heard is the honest form of this, and is not this change.
    const platformTools: OllamaTool[] =
      deps.libraryDir === "" || gadgetTools.length > 0
        ? []
        : [
            {
              type: "function",
              function: {
                name: LIST_MUSIC_TOOL,
                description:
                  "List the tracks this platform can play, each with the number it is asked for " +
                  "by. Take it whenever the person asked for a track — a title spoken inside " +
                  "another language, or a name the transcriber heard wrongly, is settled by " +
                  `choosing from what this answers — and then play one with ${PLAY_MUSIC_TOOL}.`,
                parameters: { type: "object", properties: {} },
              },
            },
            {
              type: "function",
              function: {
                name: PLAY_MUSIC_TOOL,
                description:
                  "Play one track from this platform's library through the person's own client. " +
                  "A track is named by its number on the shelf, and the number must be one " +
                  `${LIST_MUSIC_TOOL} answered with: take that shelf first if you have not, and ` +
                  "never invent a number or pass a track's name.",
                parameters: {
                  type: "object",
                  properties: {
                    index: {
                      type: "integer",
                      description: `The track's number on the shelf ${LIST_MUSIC_TOOL} answered with.`,
                    },
                  },
                  required: ["index"],
                },
              },
            },
          ];
    const tools: OllamaTool[] = [...gadgetTools, ...platformTools];
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
    const turnId = readTurnId(req.body.turnId);
    if (turnId) {
      // The answer was transcribed window by window while it was being spoken;
      // the turn only names it. A turn this process no longer holds — expired, or
      // one whose windows were never sent here — is refused rather than answered
      // from nothing.
      const claim = await transcripts.claim({ turnId });
      if (!claim) {
        sendSseEvent(res, "error", { message: "This turn is no longer available." });
        res.end();
        return;
      }
      try {
        if (!claim.outcome.ok) {
          sendSseEvent(res, "error", { message: claim.outcome.message });
          res.end();
          return;
        }
        userText = claim.outcome.text;
      } finally {
        await transcripts.discard(claim);
      }
    } else if (audioFile) {
      // The upload is already a file on disk — multer wrote it as it arrived —
      // so there is nothing to copy before transcribing, and nothing this route
      // ever holds in the heap.
      //
      // The turn already carries its language, which is the one thing the
      // transcriber cannot work out for itself on this audio: left to detect,
      // it answers short Vietnamese in Chinese, and the persona then corrects
      // the person for words they never said. See resolveSttLanguage.
      const sttResult = await deps.transcribeAudio(
        audioFile.path,
        undefined,
        resolveSttLanguage(language)
      );
      userText = sttResult.text;
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
    // The per-turn synthesis bound is the core's own serial drain: it synthesizes
    // one chunk at a time (`sentence-stream.ts`), so this route can never have
    // more than one in flight, and one long reply cannot occupy the gateway.
    // The bound in the config is the ceiling both routes are held to; the other
    // route, which schedules its own chunks, enforces it explicitly.
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
      // The `text` event names the segment about to be spoken, which is the same
      // segment the `sentence` event below carries the audio for — one event per
      // chunk, not one per sentence. The core announces a chunk just before it
      // synthesizes it (D6), so the text still arrives without waiting for
      // synthesis: that is what this event is for, and it is now also what the
      // client can count on it saying. A sentence the core splits into several
      // chunks is several `text` events, in the same order as their audio.
      //
      // Content is flowing now, so the heartbeat has done its job: every later
      // gap is between two `text`/`sentence` events, not a silence.
      onChunkStart: ({ index, text }) => {
        if (abortController.signal.aborted) return;
        cleanupHeartbeat();
        sendSseEvent(res, "text", { index, text });
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
    // The track the model asked for, if it did. Declared out here because the turn it belongs to
    // ends outside the branch that asks the model: the event is sent after the reply's last
    // sentence, which is past the end of that branch.
    //
    // A box rather than a bare `let`: it is written from inside the closure below and read at the
    // tail, and a `let` written only from a closure reads to the type checker as never written —
    // which would leave the tail unable to see a track at all, rather than unable to see one it
    // might not have. `null` is every turn on a deployment with no library, and every turn whose
    // model asked for nothing.
    const wanted: { track: Track | null } = { track: null };

    // The shelf this turn has offered the model, as it was offered. Held for the turn rather than
    // read again for each call: `readLibrary` is called per call and the directory is allowed to
    // change while the platform runs, so two readings can order the same tracks differently, and a
    // number is only an answer against the shelf the model is looking at (design D4).
    //
    // A box rather than a bare `let`, for the same reason `wanted` is one: it is written from inside
    // the closure below, and a `let` written only from a closure reads to the type checker as never
    // written.
    const offered: { tracks: readonly Track[] | null } = { tracks: null };

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
        let prompt = buildVoiceAgentPrompt(
          systemPrompt,
          language,
          llmHistory,
          knowledgeChunks.length ? knowledgeChunks : undefined,
          // The model is told what it may call, so it is told when to — and a turn with no
          // catalogue is asked exactly as it was before any of this existed.
          tools.length > 0
        );

        // A turn asks, and may be answered with a call rather than with words. The call is made
        // on the gadget by the bridge — the tool channel lives inside the device's own socket
        // and this service cannot reach it — so the turn stops, tells the bridge what was asked
        // for, and waits. What comes back joins the conversation and the model is asked again,
        // which is what makes the reply about the change rather than merely beside it.
        //
        // The loop is bounded, and bounded twice over: a call is only permitted while `rounds`
        // is under the limit, so the round after the last permitted call is asked **without**
        // tools and can only answer in words. A model that keeps asking therefore still ends
        // the turn in speech rather than in silence (design.md, "Rounds are bounded").

        /**
         * Answer a call that names a tool of this platform's own, or `null` for one that belongs to
         * the client which declared it.
         *
         * Both kinds are answered in the same round and carried back to the model in one message
         * list, so a turn that asked for both is not serialised into two.
         *
         * `shelf` is the shelf this turn had offered **before this round** — taken by the caller
         * before any of this round's calls are answered. The model may ask for the shelf and for a
         * track in one message, and settling those in the model's own order would answer a number
         * against a shelf it has not been shown yet, which is a guess taken as an answer. Both are
         * answered and the track one fails, which is what makes the model take the shelf first (D4).
         */
        async function answerHere(
          call: OllamaToolCall,
          shelf: readonly Track[] | null
        ): Promise<ToolCallOutcome | null> {
          const name = call.function.name;
          if (name !== LIST_MUSIC_TOOL && name !== PLAY_MUSIC_TOOL) return null;

          if (name === LIST_MUSIC_TOOL) {
            const library = await readLibrary(deps.libraryDir);
            if (!library.ok) return { ok: false, message: library.detail };
            // Nothing to number is not a shelf: an empty list reads as an answer, and the turn that
            // asked what can be played is owed the truth that nothing can.
            if (library.tracks.length === 0) {
              return { ok: false, message: `${deps.libraryDir} holds no track this service can serve` };
            }
            offered.tracks = library.tracks;
            return { ok: true, text: shelfAnswer(library.tracks) };
          }

          if (shelf === null) {
            return {
              ok: false,
              message:
                `no shelf of this library has been taken in this turn — ask ${LIST_MUSIC_TOOL} for ` +
                `one, then ask for a track by a number it gives`,
            };
          }

          // A number, and only a number. One handed back as text is the same number and is taken;
          // nothing else is, because a name is what the model believes it knows and this interface
          // exists because that belief is not what the library holds (D4).
          const asked = call.function.arguments["index"];
          const number =
            typeof asked === "number"
              ? asked
              : typeof asked === "string" && /^\d+$/.test(asked.trim())
                ? Number(asked.trim())
                : Number.NaN;
          if (!Number.isInteger(number) || number < 1 || number > shelf.length) {
            return {
              ok: false,
              message:
                `the shelf holds ${shelf.length} track(s), so ${JSON.stringify(asked)} is not one of ` +
                `them — answer with a number ${LIST_MUSIC_TOOL} gave`,
            };
          }

          const track = shelf[number - 1]!;
          // Held rather than played: the sentences still to be spoken belong to the reply this call
          // is inside, and a track is minutes. See where the event is sent.
          wanted.track = track;
          return { ok: true, text: `playing ${track.title}` };
        }

        let rounds = 0;
        while (true) {
          const mayCall = tools.length > 0 && rounds < config.toolCalls.maxRounds;

          const { stream: llmStream, getFullText, getToolCalls } = deps.generateChatResponseStream({
            messages: prompt,
            temperature: 0.7,
            repeat_penalty: 1.2,
            // What this gadget reported it can be asked to do. Absent for a turn that carries
            // none, so a browser turn — and every turn before this existed — asks as it did.
            ...(mayCall ? { tools } : {}),
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
            console.log(`[VoiceAgent] TTS sentence scheduled: "${clean.substring(0, 80)}" → ${chunks.length} chunk(s)`);
            // Awaited, so the read loop still stalls between tokens while the
            // sentence is spoken — which is what this route did before the move,
            // and what keeps each sentence's chunks ahead of the next sentence.
            // The core splits and indexes it (D6, D3), and its own
            // `onChunkStart` is what emits this sentence's `text` events — one
            // per chunk, each just before the `sentence` event that carries that
            // chunk's audio.
            await sentenceStream.push(clean);
          }
        }

        finalText = getFullText();
        const calls = mayCall ? getToolCalls() : [];

        // Some cloud models (e.g. kimi-k2.6:cloud) stream with empty content
        // but return full text in non-streaming mode. Fall back when streaming
        // yielded nothing — and *not* when the emptiness is a tool call, which is a different
        // thing from a model that failed to speak: the fallback would put the same question to
        // the same model and be given the same call, and the turn would spend a second request
        // learning nothing.
        if (calls.length === 0 && (streamEmpty || !finalText.trim())) {
          console.log("[VoiceAgent] Streaming yielded no text; falling back to non-streaming generateChatResponse");
          finalText = await deps.generateChatResponse({ messages: prompt, temperature: 0.7, repeat_penalty: 1.2 });
        }

        if (calls.length === 0) break;

        // A call this platform answers itself is answered here, and every other call goes out to
        // the client that declared it, exactly as it always has.
        //
        // The shelf is read once, before the round is answered: a round that takes the shelf offers it
        // to the round after, and never to itself, so a shelf and a track asked for in one message
        // cannot settle against each other (D4).
        const shelfBefore = offered.tracks;
        const answeredHere = await Promise.all(calls.map((call) => answerHere(call, shelfBefore)));

        // One turn id for the round and one hold per call: a model may ask for two things at
        // once, and each is answered on its own. Every hold is opened *before* the event that
        // carries its id, so a bridge that reports back at once is not writing into a hold that
        // does not exist yet — which is the whole reason the store is not a bare map
        // (`lib/tool-calls.ts`). A call already answered leaves no hold, because nothing is waiting
        // for it: the difference between the two kinds is exactly that one of them has someone to
        // answer.
        const turnId = randomUUID();
        const holds = new Map<number, ReturnType<typeof toolCalls.open>>();
        calls.forEach((call, index) => {
          if (answeredHere[index] !== null) return;
          const hold = toolCalls.open(`${turnId}:${index}`, config.toolCalls.timeoutMs);
          console.log(
            `[VoiceAgent] the model asked for ${call.function.name}(${JSON.stringify(call.function.arguments)}) ` +
              `— telling the bridge and waiting up to ${config.toolCalls.timeoutMs}ms`
          );
          sendSseEvent(res, "tool_call", {
            turnId,
            index,
            name: call.function.name,
            arguments: call.function.arguments,
          });
          holds.set(index, hold);
        });

        // The wait is against the client as well as the clock. The bridge answers a command the
        // grammar recognised itself and abandons this turn (4.1), so the turn can be cancelled
        // while it sits here — and a turn nobody is reading is not one to spend the whole wait on.
        // The hold that loses the race is left to time out on its own, and what it settles into
        // is never read.
        const outcomes: ToolCallOutcome[] = await Promise.all(
          calls.map((_, index) => {
            const here = answeredHere[index];
            if (here !== null && here !== undefined) return here;
            return untilCancelled(holds.get(index)!, abortController.signal);
          })
        );

        // Logged before the cancellation is acted on, so that an operator reading this log sees
        // why the turn went quiet: the model asked for something and the turn was abandoned
        // underneath it.
        for (const [index, outcome] of outcomes.entries()) {
          console.log(
            `[VoiceAgent] ${calls[index]!.function.name}: ` +
              (outcome.ok ? `done — ${outcome.text}` : `not done — ${outcome.message}`)
          );
        }

        // A cancelled turn is one nobody is reading. There is nothing further to ask the model,
        // because the connection the answer would go down is gone. The only way back to the top
        // of the loop is past this, which is what keeps a cancelled turn from asking again.
        if (abortController.signal.aborted) break;

        // What the model asked for, then what it got, in the shape a tool-calling model expects
        // them back in. A call that could not be made is carried as its own message rather than
        // dropped: the reply is meant to say what could not be done.
        prompt = [
          ...prompt,
          { role: "assistant", content: "", tool_calls: calls },
          ...calls.map((call, index) => ({
            role: "tool" as const,
            content: outcomes[index]!.ok ? outcomes[index]!.text : outcomes[index]!.message,
            tool_name: call.function.name,
          })),
        ];
        rounds++;
        }
      }

      const tailSentences = extractor.finalize(finalText);
      for (const { clean, chunks } of tailSentences) {
        if (abortController.signal.aborted) break;
        console.log(`[VoiceAgent] TTS sentence scheduled: "${clean.substring(0, 80)}" → ${chunks.length} chunk(s)`);
        await sentenceStream.push(clean);
      }

      // Before `done`, so the client is never told the turn ended while audio
      // for it is still arriving (D1).
      await sentenceStream.flush();

      // The track, after every sentence of the reply has been sent and before `done` — the same
      // place this route already refuses to end a turn early, and the same ordering the bridge
      // reaches by deferring a track to the end of its turn. A track is minutes of audio, and the
      // sentences still to be spoken belong to the reply it follows.
      //
      // Its index is one past the reply's last sentence, which is the only way the client's queue
      // can keep the reply and the track in the order they are meant to be heard: the queue plays
      // by index, and an item placed by any other rule would be placed by whichever callback ran
      // last. The turn is still reported as ended before the track has played — holding it is the
      // client's queue's own work, which is what that queue is for.
      if (wanted.track !== null && !abortController.signal.aborted) {
        sendSseEvent(res, "music", {
          index: sentenceStream.nextChunkIndex,
          url: wanted.track.url,
          title: wanted.track.title,
        });
      }

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
    await discardUpload(req.file);
  }
}

/**
 * A hold, or the turn being cancelled — whichever comes first.
 *
 * A turn can be cancelled while it waits: the bridge answers a command its own grammar
 * recognised and abandons the turn it was taking. Without this the route would sit out the
 * whole `toolCalls.timeoutMs` and then ask the model again on a connection nobody is reading,
 * which is what it did the first time a command and a tool call met.
 */
function untilCancelled(hold: Promise<ToolCallOutcome>, signal: AbortSignal): Promise<ToolCallOutcome> {
  if (signal.aborted) return Promise.resolve({ ok: false, message: "the turn was cancelled" });
  return Promise.race([
    hold,
    new Promise<ToolCallOutcome>((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, message: "the turn was cancelled" }), {
        once: true,
      });
    }),
  ]);
}

/* ── POST /api/voice-agent/tool-result ──────────────────────────── */

/**
 * What a gadget did about a call a turn asked for.
 *
 * The body is `{ turnId, index, ok, text }`, or `{ turnId, index, ok: false, message }` when it
 * could not be done. The turn that asked is holding its stream open and waiting on exactly
 * this, so the answer here says only whether a wait was found: the turn's own reply is what the
 * person is reading, and this response is for the bridge's operator.
 *
 * A result nobody is waiting on is an ordinary race rather than a fault — a turn that timed out
 * and a bridge that answered just afterwards are both behaving as they should — so it is logged
 * and answered with the truth instead of being refused at the door.
 */
async function handleToolResult(
  req: Request,
  res: Response,
  toolCalls: ToolCallStore
): Promise<void> {
  const turnId = typeof req.body.turnId === "string" ? req.body.turnId : "";
  const index = Number.isInteger(req.body.index) ? (req.body.index as number) : 0;
  if (!turnId) {
    res.status(400).json({ error: "turnId is required" });
    return;
  }

  const outcome: ToolCallOutcome =
    req.body.ok === false
      ? {
          ok: false,
          message:
            typeof req.body.message === "string" && req.body.message
              ? req.body.message
              : "the gadget did not carry it out",
        }
      : { ok: true, text: typeof req.body.text === "string" ? req.body.text : "" };

  const settled = toolCalls.settle(`${turnId}:${index}`, outcome);
  if (!settled) {
    console.warn(
      `[VoiceAgent] a tool result arrived for ${turnId}:${index} which no turn is waiting on — ` +
        "the turn it belonged to has already timed out or ended"
    );
  }
  res.status(settled ? 200 : 409).json({ settled });
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
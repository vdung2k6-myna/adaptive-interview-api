import { Router, type Request, type Response } from "express";
import multer from "multer";
import { db } from "@/lib/db";
import { interviewSessions, candidates, positions, messages } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { buildPrompt, type PromptMessage } from "@/lib/prompts";
import { generateChatResponse, generateChatResponseStream } from "@/lib/ollama";
import { OllamaError } from "@/lib/errors";
import config from "@/lib/config";
import {
  transcribeAudio,
  saveAudio,
  deleteAudio,
  detectAudioFormat,
  splitSentences,
  stripMarkdown,
  splitForTTS,
  synthesizeSpeechWithFallback,
  synthesizeLongText,
  concatWavBuffers,
  resolveVoice,
  resolveEngineForLanguage,
  SentenceStream,
  sweepStaleSegments,
  SEGMENT_MARKER,
  type SynthesizeOptions,
} from "@/lib/audio";

const upload = multer({ storage: multer.memoryStorage() });

/**
 * The collaborators a caller may replace. `speak-stream` needs its synthesizer
 * because it emits audio inline, so its SSE contract is only testable with one a
 * test supplies (design D8). A *turn* needs the three things it reaches before it
 * has anything of its own — the session it is recorded against, the file the
 * recording is written to, and the transcription of that file — because those
 * arrive first: without them there is no configuration in which a test can drive
 * a turn at all, which is why this module's STT path had no coverage.
 */
export interface VoiceRouteDeps {
  synthesizeSpeechWithFallback: typeof synthesizeSpeechWithFallback;
  transcribeAudio: typeof transcribeAudio;
  saveAudio: typeof saveAudio;
  /** The session a turn belongs to, or why it cannot be recorded. */
  sessionForTurn: (sessionId: string) => Promise<SessionForTurn>;
}

/** A session a turn may be recorded against, or the refusal to answer with. The
 * refusals are values rather than responses because the two routes report them
 * differently: `/turn` as JSON, `/stream` as an SSE event. */
export type SessionForTurn =
  | { ok: true; session: typeof interviewSessions.$inferSelect }
  | { ok: false; status: number; error: string };

/**
 * The session checks both turn routes make, in the order they make them. Kept as
 * one function rather than duplicated per route, and taking only the id, so the
 * whole of a turn's own data access stays in the routes.
 */
async function sessionForTurn(sessionId: string): Promise<SessionForTurn> {
  const sessionRows = await db
    .select()
    .from(interviewSessions)
    .where(eq(interviewSessions.id, sessionId));

  if (sessionRows.length === 0) {
    return { ok: false, status: 404, error: "Session not found" };
  }

  const session = sessionRows[0];

  if (session.mode !== "voice") {
    return { ok: false, status: 403, error: "Session is not in voice mode" };
  }

  if (session.status === "completed") {
    return { ok: false, status: 403, error: "Interview has already concluded" };
  }

  return { ok: true, session };
}

const router = Router();

/* ── SSE helper ─────────────────────────────────────────────────── */
function sendSseEvent(res: Response, event: string, data: unknown) {
  try {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(payload);
    // Flush through any compression/buffering middleware so the client receives
    // events as soon as they are produced, rather than batched at the end.
    (res as Response & { flush?: () => void }).flush?.();
  } catch {
    // Client may have disconnected
  }
}

/**
 * Delete all audio files associated with saved URL paths, right now.
 *
 * Only for the case where the client that was told about them is provably gone:
 * the response has been aborted or has already ended, so there is nobody left to
 * fetch them. Everywhere else a turn's segment files are left to
 * `sweepStaleSegments`, which removes them by age — an announcement and an
 * immediate delete in adjacent ticks is what made an announced segment
 * unretrievable in the first place, and a client that is still connected may
 * still be fetching one (design D2).
 */
async function cleanupSavedAudio(urls: string[]): Promise<void> {
  await Promise.all(urls.map((url) => deleteAudio(url).catch(() => undefined)));
}

/**
 * Reclaim a turn's segment files that have aged out, best-effort.
 *
 * Called where the turn ends and the client may still be connected, in place of
 * deleting the segments just announced. The window comes from config so it is
 * one knob rather than a constant per call site, and a sweep that finds nothing
 * aged out — the normal case — costs one directory read.
 */
async function sweepAgedSegments(): Promise<void> {
  await sweepStaleSegments(config.audio.segmentRetentionMs).catch((err) => {
    console.warn("[POST /api/voice/stream] Segment sweep failed:", err);
  });
}

/**
 * Return true if the text has an unmatched opening fenced code block marker.
 * Used during streaming TTS to avoid speaking partial fence content (including
 * the language tag) before the closing fence arrives.
 */
function hasUnclosedCodeFence(text: string): boolean {
  const fenceMatches = text.match(/```/g);
  return !!fenceMatches && fenceMatches.length % 2 === 1;
}

/* ── POST /api/voice/start ──────────────────────────────────────── */
router.post("/start", async (req, res) => {
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      abortController.abort();
    }
  };
  res.on("close", onDisconnect);

  try {
    const { sessionId } = req.body as { sessionId?: string };

    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const sessionRows = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, sessionId));

    if (sessionRows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const session = sessionRows[0];

    if (session.mode !== "voice") {
      res.status(403).json({ error: "Session is not in voice mode" });
      return;
    }

    const existingMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId));

    if (existingMessages.length > 0) {
      res.status(409).json({ error: "Session already has messages" });
      return;
    }

    const candidateRows = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, session.candidateId));

    const positionRows = await db
      .select()
      .from(positions)
      .where(eq(positions.id, session.positionId));

    const candidate = candidateRows[0];
    const position = positionRows[0];

    if (!candidate || !position) {
      res.status(404).json({ error: "Related candidate or position not found" });
      return;
    }

    const requestedEngine = (session.ttsProvider as "kokoro" | "piper") || "kokoro";
    const language = (session.language as "english" | "vietnamese") || "english";
    const engine = resolveEngineForLanguage(requestedEngine, language);

    const prompt = await buildPrompt(
      {
        id: session.id,
        positionId: session.positionId,
        status: session.status,
        language,
        maxTurns: session.maxTurns,
        currentTurn: session.currentTurn,
        position: {
          title: position.title,
          level: position.level,
          jobDescription: position.jobDescription,
          requirements: position.requirements,
        },
        candidate: {
          name: candidate.name,
          skills: candidate.skills,
          experienceYears: candidate.experienceYears,
          cv: candidate.cv,
        },
      },
      []
    );

    let questionText: string;
    try {
      questionText = stripMarkdown(await generateChatResponse({
        messages: prompt,
        temperature: 0.7,
      }));
    } catch (err) {
      console.error("[POST /api/voice/start] LLM error:", err);
      if (err instanceof OllamaError) {
        res.status(503).json({ error: `Failed to generate question: ${err.message}` });
        return;
      }
      res.status(500).json({ error: "Failed to generate question. Please try again." });
      return;
    }

    let audioUrl: string | undefined;
    try {
      const result = await synthesizeLongText(questionText, {
        engine,
        voice: resolveVoice(engine, language),
        sessionId,
        prefix: "interviewer",
        signal: abortController.signal,
      });
      audioUrl = result.urlPath;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.log("[POST /api/voice/start] Client disconnected during TTS.");
        return;
      }
      console.error("[POST /api/voice/start] TTS error:", err);
    }

    if (abortController.signal.aborted || res.writableEnded) {
      return;
    }

    const msgRows = await db
      .insert(messages)
      .values({
        sessionId,
        role: "interviewer",
        content: questionText,
        audioUrl,
        audioFormat: audioUrl ? "wav" : null,
      })
      .returning();

    if (session.status === "created") {
      await db
        .update(interviewSessions)
        .set({ status: "in_progress" })
        .where(eq(interviewSessions.id, sessionId));
    }

    res.json({
      success: true,
      interviewerMessage: {
        id: msgRows[0].id,
        content: questionText,
        audioUrl: audioUrl || null,
        createdAt: msgRows[0].createdAt,
      },
      session: {
        status: "in_progress",
        currentTurn: 0,
        maxTurns: session.maxTurns,
      },
    });
  } catch (err) {
    console.error("[POST /api/voice/start] UNEXPECTED ERROR:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start voice interview" });
  }
});

/* ── POST /api/voice/turn ───────────────────────────────────────── */
async function handleTurn(req: Request, res: Response, deps: VoiceRouteDeps): Promise<void> {
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      abortController.abort();
    }
  };
  res.on("close", onDisconnect);

  try {
    const sessionId = req.body.sessionId as string | undefined;
    const audioFile = req.file;

    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    if (!audioFile) {
      res.status(400).json({ error: "audio is required" });
      return;
    }

    const found = await deps.sessionForTurn(sessionId);

    if (!found.ok) {
      res.status(found.status).json({ error: found.error });
      return;
    }

    const session = found.session;

    const audioExt = audioFile.mimetype === "audio/wav" ? "wav" : "webm";
    const audioBuffer = audioFile.buffer;
    const { filePath: candidateAudioPath, urlPath: candidateAudioUrl } = await deps.saveAudio(
      sessionId,
      audioBuffer,
      "candidate",
      audioExt
    );

    let transcription: string;
    let sttConfidence: number | undefined;
    try {
      const sttResult = await deps.transcribeAudio(candidateAudioPath);
      transcription = sttResult.text;
      sttConfidence = sttResult.confidence;
    } catch (err) {
      console.error("[POST /api/voice/turn] STT error:", err);
      res.status(500).json({ error: "Failed to transcribe audio. Please try again." });
      return;
    }

    // Heard nothing. The STT client reports this as an empty transcript rather
    // than throwing, which is the right shape for an answer that was not given —
    // but it must not be stored: an empty candidate message would enter the
    // transcript and the scoring as a real answer, and the next question would be
    // generated from it. 400 rather than 500, since the service answered, and a
    // code as well as a message so the client can say it in the reader's language.
    if (!transcription) {
      console.error("[POST /api/voice/turn] STT returned no words");
      res.status(400).json({ code: "no_speech", error: "No speech detected. Please try again." });
      return;
    }

    const candidateMsgRows = await db
      .insert(messages)
      .values({
        sessionId,
        role: "candidate",
        content: transcription,
        audioUrl: candidateAudioUrl,
        audioFormat: audioExt,
        sttConfidence: sttConfidence ? Math.round(sttConfidence * 100) : null,
      })
      .returning();

    const candidateMessage = candidateMsgRows[0];

    const candidateRows = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, session.candidateId));

    const positionRows = await db
      .select()
      .from(positions)
      .where(eq(positions.id, session.positionId));

    const candidate = candidateRows[0];
    const position = positionRows[0];

    if (!candidate || !position) {
      res.status(404).json({ error: "Related candidate or position not found" });
      return;
    }

    const existingMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt);

    const requestedEngine = (session.ttsProvider as "kokoro" | "piper") || "kokoro";
    const language = (session.language as "english" | "vietnamese") || "english";
    const engine = resolveEngineForLanguage(requestedEngine, language);

    const promptMessages: PromptMessage[] = existingMessages.map((m) => ({
      role: m.role as "interviewer" | "candidate",
      content: m.content,
    }));

    const prompt = await buildPrompt(
      {
        id: session.id,
        positionId: session.positionId,
        status: "in_progress",
        language,
        maxTurns: session.maxTurns,
        currentTurn: session.currentTurn,
        position: {
          title: position.title,
          level: position.level,
          jobDescription: position.jobDescription,
          requirements: position.requirements,
        },
        candidate: {
          name: candidate.name,
          skills: candidate.skills,
          experienceYears: candidate.experienceYears,
          cv: candidate.cv,
        },
      },
      promptMessages
    );

    const newTurn = session.currentTurn + 1;

    if (newTurn >= session.maxTurns) {
      await db
        .update(interviewSessions)
        .set({ status: "completed", currentTurn: newTurn, completedAt: new Date() })
        .where(eq(interviewSessions.id, sessionId));

      const completionText = "Thank you, the interview is complete.";

      let interviewerAudioUrl: string | undefined;
      try {
        const result = await synthesizeLongText(completionText, {
          engine,
          voice: resolveVoice(engine, language),
          sessionId,
          prefix: "interviewer",
          signal: abortController.signal,
        });
        interviewerAudioUrl = result.urlPath;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          console.log("[POST /api/voice/turn] Client disconnected during completion TTS.");
          return;
        }
        console.error("[POST /api/voice/turn] TTS error for completion:", err);
      }

      if (abortController.signal.aborted || res.writableEnded) {
        return;
      }

      const interviewerMsgRows = await db
        .insert(messages)
        .values({
          sessionId,
          role: "interviewer",
          content: completionText,
          audioUrl: interviewerAudioUrl,
          audioFormat: interviewerAudioUrl ? "wav" : null,
        })
        .returning();

      res.json({
        success: true,
        candidateMessage: {
          id: candidateMessage.id,
          content: candidateMessage.content,
          audioUrl: candidateMessage.audioUrl,
          createdAt: candidateMessage.createdAt,
        },
        interviewerMessage: {
          id: interviewerMsgRows[0].id,
          content: completionText,
          audioUrl: interviewerAudioUrl || null,
          createdAt: interviewerMsgRows[0].createdAt,
        },
        session: {
          status: "completed",
          currentTurn: newTurn,
          maxTurns: session.maxTurns,
        },
      });
      return;
    }

    let questionText: string;
    try {
      questionText = stripMarkdown(await generateChatResponse({
        messages: prompt,
        temperature: 0.7,
      }));
    } catch (err) {
      console.error("[POST /api/voice/turn] LLM error:", err);
      if (err instanceof OllamaError) {
        res.status(503).json({ error: `Failed to generate question: ${err.message}` });
        return;
      }
      res.status(500).json({ error: "Failed to generate question. Please try again." });
      return;
    }

    let interviewerAudioUrl: string | undefined;
    try {
      const result = await synthesizeLongText(questionText, {
        engine,
        voice: resolveVoice(engine, language),
        sessionId,
        prefix: "interviewer",
        signal: abortController.signal,
      });
      interviewerAudioUrl = result.urlPath;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.log("[POST /api/voice/turn] Client disconnected during TTS.");
        return;
      }
      console.error("[POST /api/voice/turn] TTS error:", err);
    }

    if (abortController.signal.aborted || res.writableEnded) {
      return;
    }

    const interviewerMsgRows = await db
      .insert(messages)
      .values({
        sessionId,
        role: "interviewer",
        content: questionText,
        audioUrl: interviewerAudioUrl,
        audioFormat: interviewerAudioUrl ? "wav" : null,
      })
      .returning();

    await db
      .update(interviewSessions)
      .set({ currentTurn: newTurn, status: "in_progress" })
      .where(eq(interviewSessions.id, sessionId));

    res.json({
      success: true,
      candidateMessage: {
        id: candidateMessage.id,
        content: candidateMessage.content,
        audioUrl: candidateMessage.audioUrl,
        createdAt: candidateMessage.createdAt,
      },
      interviewerMessage: {
        id: interviewerMsgRows[0].id,
        content: questionText,
        audioUrl: interviewerAudioUrl || null,
        createdAt: interviewerMsgRows[0].createdAt,
      },
      session: {
        status: "in_progress",
        currentTurn: newTurn,
        maxTurns: session.maxTurns,
      },
    });
  } catch (err) {
    console.error("[POST /api/voice/turn] UNEXPECTED ERROR:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to process voice turn" });
  }
}

/* ── POST /api/voice/stream ─────────────────────────────────────── */
async function handleStreamTurn(req: Request, res: Response, deps: VoiceRouteDeps): Promise<void> {
  // Set SSE headers immediately
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Track generated chunk files so we can delete them if the client disconnects.
  const savedUrls: string[] = [];

  // AbortController lets us cancel the LLM stream and active Audio Gateway requests on disconnect.
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      abortController.abort();
    }
  };
  // For SSE, res "close" fires when the underlying connection is closed by the client.
  // If the response ends normally (res.end()), writableEnded will be true, so we ignore it.
  res.on("close", onDisconnect);

  try {
    const sessionId = req.body.sessionId as string | undefined;
    const audioFile = req.file;

    if (!sessionId) {
      sendSseEvent(res, "error", { message: "sessionId is required" });
      res.end();
      return;
    }
    if (!audioFile) {
      sendSseEvent(res, "error", { message: "audio is required" });
      res.end();
      return;
    }

    const found = await deps.sessionForTurn(sessionId);

    if (!found.ok) {
      sendSseEvent(res, "error", { message: found.error });
      res.end();
      return;
    }

    const session = found.session;

    const audioExt = audioFile.mimetype === "audio/wav" ? "wav" : "webm";
    const audioBuffer = audioFile.buffer;
    const { filePath: candidateAudioPath, urlPath: candidateAudioUrl } = await deps.saveAudio(
      sessionId,
      audioBuffer,
      "candidate",
      audioExt
    );

    let transcription: string;
    let sttConfidence: number | undefined;
    try {
      const sttResult = await deps.transcribeAudio(candidateAudioPath);
      transcription = sttResult.text;
      sttConfidence = sttResult.confidence;
    } catch (err) {
      console.error("[POST /api/voice/stream] STT error:", err);
      sendSseEvent(res, "error", { message: "Failed to transcribe audio. Please try again." });
      res.end();
      return;
    }

    // Heard nothing — see the `/api/voice/turn` note above: the same empty
    // transcript reaches here as a value rather than a throw, and storing it would
    // put a candidate answer in the transcript that was never given. A `notice`
    // rather than an `error`, for the reason the voice-agent route gives: nothing
    // failed. The `/turn` route has no side channel to be gentle on — its 400
    // carries the same code for the client to read.
    if (!transcription) {
      console.error("[POST /api/voice/stream] STT returned no words");
      sendSseEvent(res, "notice", {
        code: "no_speech",
        message: "No speech detected. Please try again.",
      });
      res.end();
      return;
    }

    const candidateMsgRows = await db
      .insert(messages)
      .values({
        sessionId,
        role: "candidate",
        content: transcription,
        audioUrl: candidateAudioUrl,
        audioFormat: audioExt,
        sttConfidence: sttConfidence ? Math.round(sttConfidence * 100) : null,
      })
      .returning();

    sendSseEvent(res, "candidate", {
      text: transcription,
      audioUrl: candidateAudioUrl,
      confidence: sttConfidence ?? null,
      messageId: candidateMsgRows[0].id,
    });

    const newTurn = session.currentTurn + 1;
    const streamLanguage = (session.language as "english" | "vietnamese") || "english";
    const streamEngine = resolveEngineForLanguage(
      (session.ttsProvider as "kokoro" | "piper") || "kokoro",
      streamLanguage
    );

    if (newTurn >= session.maxTurns) {
      await db
        .update(interviewSessions)
        .set({ status: "completed", currentTurn: newTurn, completedAt: new Date() })
        .where(eq(interviewSessions.id, sessionId));

      const completionText = streamLanguage === "vietnamese"
        ? "Cảm ơn bạn, buổi phỏng vấn đã kết thúc."
        : "Thank you, the interview is complete.";

      let interviewerAudioUrl: string | undefined;
      try {
        const ttsOptions: SynthesizeOptions = {
          engine: streamEngine,
          voice: resolveVoice(streamEngine, streamLanguage),
          signal: abortController.signal,
        };
        const ttsBuffer = await synthesizeSpeechWithFallback(completionText, ttsOptions, 0, abortController.signal);
        const { urlPath } = await deps.saveAudio(sessionId, ttsBuffer, "interviewer", "wav");
        interviewerAudioUrl = urlPath;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          await cleanupSavedAudio(savedUrls);
          return;
        }
        console.error("[POST /api/voice/stream] TTS error for completion:", err);
      }

      const interviewerMsgRows = await db
        .insert(messages)
        .values({
          sessionId,
          role: "interviewer",
          content: completionText,
          audioUrl: interviewerAudioUrl,
          audioFormat: interviewerAudioUrl ? "wav" : null,
        })
        .returning();

      if (!abortController.signal.aborted) {
        sendSseEvent(res, "sentence", {
          index: 0,
          text: completionText,
          audioUrl: interviewerAudioUrl || null,
        });

        sendSseEvent(res, "done", {
          session: {
            status: "completed",
            currentTurn: newTurn,
            maxTurns: session.maxTurns,
          },
          messageId: interviewerMsgRows[0].id,
        });
      }

      res.end();
      return;
    }

    const candidateRows = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, session.candidateId));

    const positionRows = await db
      .select()
      .from(positions)
      .where(eq(positions.id, session.positionId));

    const candidate = candidateRows[0];
    const position = positionRows[0];

    if (!candidate || !position) {
      sendSseEvent(res, "error", { message: "Related candidate or position not found" });
      res.end();
      return;
    }

    const existingMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt);

    const promptMessages: PromptMessage[] = existingMessages.map((m) => ({
      role: m.role as "interviewer" | "candidate",
      content: m.content,
    }));

    const prompt = await buildPrompt(
      {
        id: session.id,
        positionId: session.positionId,
        status: "in_progress",
        language: streamLanguage,
        maxTurns: session.maxTurns,
        currentTurn: session.currentTurn,
        position: {
          title: position.title,
          level: position.level,
          jobDescription: position.jobDescription,
          requirements: position.requirements,
        },
        candidate: {
          name: candidate.name,
          skills: candidate.skills,
          experienceYears: candidate.experienceYears,
          cv: candidate.cv,
        },
      },
      promptMessages
    );

    const ttsOptions: SynthesizeOptions = {
      engine: streamEngine,
      voice: resolveVoice(streamEngine, streamLanguage),
      signal: abortController.signal,
    };

    const { stream: llmStream, getFullText } = generateChatResponseStream({
      messages: prompt,
      temperature: 0.7,
    });

    let accumulatedText = "";
    const sentenceBuffers: (Buffer | null)[] = [];
    let sentenceIndex = 0;
    let chunkIndex = 0;
    const pendingTTS: Promise<void>[] = [];

    const resolvedMap = new Map<
      number,
      { index: number; buffer: Buffer | null; text: string; urlPath: string | null }
    >();
    let nextEmitIndex = 0;

    function tryEmitOrdered() {
      while (resolvedMap.has(nextEmitIndex)) {
        const result = resolvedMap.get(nextEmitIndex)!;
        resolvedMap.delete(nextEmitIndex);
        if (result.buffer) {
          sentenceBuffers[result.index] = result.buffer;
        }
        if (!abortController.signal.aborted) {
          sendSseEvent(res, "sentence", {
            index: result.index,
            text: result.text,
            audioUrl: result.urlPath,
          });
        }
        nextEmitIndex++;
      }
    }

    const enqueueTTS = (
      idx: number,
      sentenceText: string,
      ttsFn: () => Promise<Buffer>
    ) => {
      const promise = (async () => {
        try {
          const buffer = await ttsFn();
          const fmt = detectAudioFormat(buffer);
          if (fmt === "bin") {
            return { index: idx, buffer: null, text: sentenceText, urlPath: null };
          }
          const { urlPath } = await deps.saveAudio(
            sessionId,
            buffer,
            `${SEGMENT_MARKER}-${idx}`,
            fmt
          );
          // Track the URL immediately so cleanup can find it even if the route exits before .then() fires.
          savedUrls.push(urlPath);
          return { index: idx, buffer, text: sentenceText, urlPath };
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return { index: idx, buffer: null, text: sentenceText, urlPath: null };
          }
          console.error(`[POST /api/voice/stream] TTS error for sentence ${idx}:`, err);
          return { index: idx, buffer: null, text: sentenceText, urlPath: null };
        }
      })();
      pendingTTS.push(
        promise.then((result) => {
          resolvedMap.set(result.index, result);
          tryEmitOrdered();
        })
      );
    };

    const reader = llmStream.getReader();
    let llmError: Error | null = null;

    try {
      while (true) {
        if (abortController.signal.aborted || res.writableEnded) {
          await reader.cancel();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          accumulatedText += value;

          const strippedAccumulated = stripMarkdown(accumulatedText);

          // If a fenced code block is still open, wait for the closing fence before
          // splitting sentences. Otherwise the language tag (e.g., "markdown") and
          // partial fence markers get sent to TTS.
          if (hasUnclosedCodeFence(accumulatedText)) {
            continue;
          }

          const allSentences = splitSentences(strippedAccumulated);
          for (let i = sentenceIndex; i < allSentences.length; i++) {
            if (abortController.signal.aborted || res.writableEnded) {
              await reader.cancel();
              break;
            }
            const sentenceText = allSentences[i];
            if (!/[.!?…。？！]$/.test(sentenceText)) {
              break;
            }
            const chunks = splitForTTS(sentenceText);
            for (const chunk of chunks) {
              if (abortController.signal.aborted || res.writableEnded) {
                await reader.cancel();
                break;
              }
              const idx = chunkIndex++;
              enqueueTTS(idx, chunk, () => synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal));
            }
            sentenceIndex++;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        llmError = null;
      } else {
        llmError = err instanceof Error ? err : new Error(String(err));
      }
    }

    // If the client disconnected mid-stream, abandon queued work and clean up.
    if (abortController.signal.aborted || res.writableEnded) {
      await cleanupSavedAudio(savedUrls);
      res.end();
      return;
    }

    if (llmError) {
      console.error("[POST /api/voice/stream] LLM error:", llmError);
      // The client is still connected, so segments announced before the stream
      // broke may still be in flight — the sweep is what removes them, not this.
      await sweepAgedSegments();
      sendSseEvent(res, "error", {
        message:
          llmError instanceof OllamaError
            ? `Failed to generate question: ${llmError.message}`
            : "Failed to generate question. Please try again.",
      });
      res.end();
      return;
    }

    const fullText = getFullText().trim() || accumulatedText.trim();
    if (!fullText) {
      // As above: still connected, so nothing announced is deleted here.
      await sweepAgedSegments();
      sendSseEvent(res, "error", { message: "LLM returned empty response" });
      res.end();
      return;
    }

    const cleanFullText = stripMarkdown(fullText);
    const finalSentences = splitSentences(cleanFullText);
    if (finalSentences.length > sentenceIndex) {
      for (let i = sentenceIndex; i < finalSentences.length; i++) {
        const sentenceText = finalSentences[i];
        const chunks = splitForTTS(sentenceText);
        for (const chunk of chunks) {
          if (abortController.signal.aborted || res.writableEnded) {
            await cleanupSavedAudio(savedUrls);
            res.end();
            return;
          }
          const idx = chunkIndex++;
          enqueueTTS(idx, chunk, () => synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal));
        }
        sentenceIndex++;
      }
    } else {
      const lastDelimiterMatch = [...cleanFullText.matchAll(/[.!?…。？！]+/g)].pop();
      const tailStart = lastDelimiterMatch
        ? lastDelimiterMatch.index! + lastDelimiterMatch[0].length
        : 0;
      const tail = cleanFullText.slice(tailStart).trim();
      if (tail) {
        const chunks = splitForTTS(tail);
        for (const chunk of chunks) {
          if (abortController.signal.aborted || res.writableEnded) {
            await cleanupSavedAudio(savedUrls);
            res.end();
            return;
          }
          const idx = chunkIndex++;
          enqueueTTS(idx, chunk, () => synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal));
        }
        sentenceIndex++;
      }
    }

    // Wait for remaining TTS only if the client is still connected.
    if (!abortController.signal.aborted && !res.writableEnded) {
      await Promise.all(pendingTTS);
    }

    // If the client disconnected while we were awaiting TTS, clean up and exit.
    if (abortController.signal.aborted || res.writableEnded) {
      await cleanupSavedAudio(savedUrls);
      res.end();
      return;
    }

    let interviewerAudioUrl: string | undefined;
    let combinedFormat: string | null = null;
    const validBuffers = sentenceBuffers.filter((b): b is Buffer => b !== null && b !== undefined);
    if (validBuffers.length > 0) {
      try {
        const allWav = validBuffers.every(
          (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "RIFF"
        );
        if (allWav) {
          const combinedBuffer =
            validBuffers.length === 1
              ? validBuffers[0]
              : concatWavBuffers(validBuffers, 0.3);
          const { urlPath } = await deps.saveAudio(sessionId, combinedBuffer, "interviewer", "wav");
          interviewerAudioUrl = urlPath;
          combinedFormat = "wav";
        } else {
          const fmt = detectAudioFormat(validBuffers[0]);
          const { urlPath } = await deps.saveAudio(sessionId, validBuffers[0], "interviewer", fmt);
          interviewerAudioUrl = urlPath;
          combinedFormat = fmt;
        }

        // The combined file is now the canonical audio, so the segments are
        // redundant — but not yet unneeded. The last segment was announced a
        // few ticks ago and its client may still be fetching it, so the turn
        // ends by sweeping what has aged out instead of deleting what it just
        // announced (design D2). The canonical file is not a segment and is
        // never in the sweep's path.
        await sweepAgedSegments();
      } catch (err) {
        console.error("[POST /api/voice/stream] Audio concat error:", err);
      }
    }

    const interviewerMsgRows = await db
      .insert(messages)
      .values({
        sessionId,
        role: "interviewer",
        content: cleanFullText,
        audioUrl: interviewerAudioUrl,
        audioFormat: combinedFormat,
      })
      .returning();

    await db
      .update(interviewSessions)
      .set({ currentTurn: newTurn, status: "in_progress" })
      .where(eq(interviewSessions.id, sessionId));

    sendSseEvent(res, "done", {
      session: {
        status: "in_progress",
        currentTurn: newTurn,
        maxTurns: session.maxTurns,
      },
      messageId: interviewerMsgRows[0].id,
      fullText: cleanFullText,
      audioUrl: interviewerAudioUrl || null,
    });

    res.end();
  } catch (err) {
    console.error("[POST /api/voice/stream] UNEXPECTED ERROR:", err);
    // Whether the client is still there is unknown here, and deleting on a
    // connected client is the failure this change exists to remove — so the
    // sweep reclaims, and anything too young is left for the next turn.
    await sweepAgedSegments();
    try {
      sendSseEvent(res, "error", {
        message: err instanceof Error ? err.message : "Failed to process voice turn",
      });
    } catch {
      // Stream may already be closed
    }
    res.end();
  }
}

/* ── POST /api/voice/speak ──────────────────────────────────────── */
router.post("/speak", async (req, res) => {
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      abortController.abort();
    }
  };
  res.on("close", onDisconnect);

  try {
    const { text, voice, engine, language: requestLanguage } = req.body as {
      text?: string;
      voice?: string;
      engine?: "kokoro" | "piper";
      language?: string;
    };

    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const resolvedLanguage: "english" | "vietnamese" =
      requestLanguage === "vietnamese" ? "vietnamese" : "english";
    const resolvedEngine = resolveEngineForLanguage(engine, resolvedLanguage);

    const result = await synthesizeLongText(text, {
      engine: resolvedEngine,
      voice: voice || resolveVoice(resolvedEngine, resolvedLanguage),
      signal: abortController.signal,
    });

    if (abortController.signal.aborted || res.writableEnded) {
      return;
    }

    const audioBuffer = result.buffer;

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(audioBuffer.length));
    res.send(audioBuffer);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log("[POST /api/voice/speak] Client disconnected during TTS.");
      return;
    }
    console.error("[POST /api/voice/speak] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "TTS failed" });
  }
});

/* ── POST /api/voice/speak-stream ───────────────────────────────── */
/**
 * Register the turn routes on `router`, taking the session lookup, the audio
 * store and the transcriber from `deps` — the seam that lets a test drive a turn
 * with no Postgres, no audio directory and no STT service. Paths, bodies, status
 * codes and event sequences are unchanged.
 */
function registerTurnRoutes(router: Router, deps: VoiceRouteDeps): void {
  router.post("/turn", upload.single("audio"), (req, res) => handleTurn(req, res, deps));
  router.post("/stream", upload.single("audio"), (req, res) => handleStreamTurn(req, res, deps));
}

/**
 * Register the endpoint on `router`, taking its synthesizer from `deps` — the
 * seam that lets a test drive this route's SSE contract without an audio
 * gateway (design D8). The path, the event sequence, and the transport guards
 * are unchanged.
 */
function registerSpeakStream(router: Router, deps: VoiceRouteDeps): void {
  router.post("/speak-stream", (req, res) => handleSpeakStream(req, res, deps));
}

async function handleSpeakStream(
  req: Request,
  res: Response,
  deps: VoiceRouteDeps
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // AbortController lets us cancel the active Audio Gateway request on disconnect.
  const abortController = new AbortController();
  const onDisconnect = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      abortController.abort();
    }
  };
  // For SSE, res "close" fires when the underlying connection is closed by the client.
  // If the response ends normally (res.end()), writableEnded will be true, so we ignore it.
  res.on("close", onDisconnect);

  try {
    const { text, engine, language: requestLanguage } = req.body as {
      text?: string;
      engine?: "kokoro" | "piper";
      language?: string;
    };

    if (!text || typeof text !== "string") {
      sendSseEvent(res, "error", { message: "text is required" });
      res.end();
      return;
    }

    const resolvedLanguage: "english" | "vietnamese" =
      requestLanguage === "vietnamese" ? "vietnamese" : "english";
    const resolvedEngine = resolveEngineForLanguage(engine, resolvedLanguage);

    const cleanText = stripMarkdown(text);
    const sentences = splitSentences(cleanText);

    if (sentences.length === 0) {
      sendSseEvent(res, "done", {});
      res.end();
      return;
    }

    const ttsOptions: SynthesizeOptions = {
      engine: resolvedEngine,
      voice: resolveVoice(resolvedEngine, resolvedLanguage),
      signal: abortController.signal,
    };
    // The chunk pipeline is the shared core (D1): it owns the index, the
    // `splitForTTS` chunking and the null-audio rule, while the wire stays here.
    // This route is the caller that hands the core a whole text's sentences up
    // front, one `push` each.
    const stream = new SentenceStream({
      synthesize: (chunk) =>
        deps.synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal),
      signal: abortController.signal,
      // The transport guard belongs here, not in the core, which never sees
      // `res` (D5). A response that has already ended means nothing may be
      // written; the core stops on the same signal from `res.on("close")`.
      onChunk: ({ index, text, buffer }) => {
        if (res.writableEnded || abortController.signal.aborted) {
          return;
        }
        sendSseEvent(res, "sentence", {
          index,
          text,
          audioData: buffer ? buffer.toString("base64") : null,
        });
      },
      // No synthesizable content (e.g. pure punctuation) and unrecoverable TTS
      // errors arrive here as a failed chunk: the core emits it as null audio at
      // its own index so the frontend can skip it without stalling the sentence
      // index sequence (D4), and this only reports it. An abort is not a failure
      // and never reaches here.
      onError: (err, { index }) => {
        console.warn(
          `[POST /api/voice/speak-stream] TTS skipped for chunk ${index}:`,
          err instanceof Error ? err.message : err
        );
      },
    });

    for (const sentenceText of sentences) {
      await stream.push(sentenceText);
    }
    await stream.flush();

    // A disconnected client gets no `done`: the response is already gone, and
    // the closing event is this route's own, after the drain (D5).
    if (res.writableEnded || abortController.signal.aborted) {
      return;
    }

    sendSseEvent(res, "done", {});
    res.end();
  } catch (err) {
    console.error("[POST /api/voice/speak-stream] error:", err);
    try {
      sendSseEvent(res, "error", {
        message: err instanceof Error ? err.message : "Failed to synthesize speech",
      });
    } catch {
      // Stream may already be closed
    }
    res.end();
  }
}

/**
 * `/api/voice` — the interview session's voice routes plus the two speak
 * endpoints. `synthesizeSpeechWithFallback` is the one collaborator a caller may
 * replace (design D8). Every other route stays registered exactly as it was, on
 * the same router instance and paths, so `src/index.ts`'s mount is unchanged.
 */
export function createVoiceRouter(overrides: Partial<VoiceRouteDeps> = {}): Router {
  const deps: VoiceRouteDeps = {
    synthesizeSpeechWithFallback,
    transcribeAudio,
    saveAudio,
    sessionForTurn,
    ...overrides,
  };
  const composed = Router();
  composed.use(router);
  registerTurnRoutes(composed, deps);
  registerSpeakStream(composed, deps);
  return composed;
}

export default createVoiceRouter();

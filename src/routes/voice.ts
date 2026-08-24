import { Router, type Response } from "express";
import multer from "multer";
import { db } from "@/lib/db";
import { interviewSessions, candidates, positions, messages } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { buildPrompt, type PromptMessage } from "@/lib/prompts";
import { generateChatResponse, generateChatResponseStream } from "@/lib/ollama";
import { OllamaError } from "@/lib/errors";
import {
  transcribeAudio,
  synthesizeSpeech,
  saveAudio,
  deleteAudio,
  detectAudioFormat,
  splitSentences,
  stripMarkdown,
  splitForTTS,
  synthesizeSpeechWithFallback,
  synthesizeChunkWithFallback,
  concatWavBuffers,
  type SynthesizeOptions,
  type SynthesizeResult,
} from "@/lib/audio";

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

/* ── SSE helper ─────────────────────────────────────────────────── */
function sendSseEvent(res: Response, event: string, data: unknown) {
  try {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(payload);
  } catch {
    // Client may have disconnected
  }
}

/**
 * Delete all audio files associated with saved URL paths.
 * Used to clean up partially-synthesized chunks when a client disconnects.
 */
async function cleanupSavedAudio(urls: string[]): Promise<void> {
  await Promise.all(urls.map((url) => deleteAudio(url).catch(() => undefined)));
}

/* ── POST /api/voice/start ──────────────────────────────────────── */
router.post("/start", async (req, res) => {
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

    const prompt = await buildPrompt(
      {
        id: session.id,
        positionId: session.positionId,
        status: session.status,
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
      questionText = await generateChatResponse({
        messages: prompt,
        temperature: 0.7,
      });
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
      const ttsOptions: SynthesizeOptions = {
        engine: (session.ttsProvider as "kokoro" | "piper") || "kokoro",
      };
      const ttsBuffer = await synthesizeSpeech(questionText, ttsOptions);
      const { urlPath } = await saveAudio(sessionId, ttsBuffer, "interviewer", "wav");
      audioUrl = urlPath;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.error("[POST /api/voice/start] TTS timed out — Audio Gateway took too long.");
      } else {
        console.error("[POST /api/voice/start] TTS error:", err);
      }
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
router.post("/turn", upload.single("audio"), async (req, res) => {
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

    if (session.status === "completed") {
      res.status(403).json({ error: "Interview has already concluded" });
      return;
    }

    const audioExt = audioFile.mimetype === "audio/wav" ? "wav" : "webm";
    const audioBuffer = audioFile.buffer;
    const { filePath: candidateAudioPath, urlPath: candidateAudioUrl } = await saveAudio(
      sessionId,
      audioBuffer,
      "candidate",
      audioExt
    );

    let transcription: string;
    let sttConfidence: number | undefined;
    try {
      const sttResult = await transcribeAudio(candidateAudioPath);
      transcription = sttResult.text;
      sttConfidence = sttResult.confidence;
    } catch (err) {
      console.error("[POST /api/voice/turn] STT error:", err);
      res.status(500).json({ error: "Failed to transcribe audio. Please try again." });
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

    const promptMessages: PromptMessage[] = existingMessages.map((m) => ({
      role: m.role as "interviewer" | "candidate",
      content: m.content,
    }));

    const prompt = await buildPrompt(
      {
        id: session.id,
        positionId: session.positionId,
        status: "in_progress",
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
        const ttsOptions: SynthesizeOptions = {
          engine: (session.ttsProvider as "kokoro" | "piper") || "kokoro",
        };
        const ttsBuffer = await synthesizeSpeech(completionText, ttsOptions);
        const { urlPath } = await saveAudio(sessionId, ttsBuffer, "interviewer", "wav");
        interviewerAudioUrl = urlPath;
      } catch (err) {
        console.error("[POST /api/voice/turn] TTS error for completion:", err);
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
      questionText = await generateChatResponse({
        messages: prompt,
        temperature: 0.7,
      });
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
      const ttsOptions: SynthesizeOptions = {
        engine: (session.ttsProvider as "kokoro" | "piper") || "kokoro",
      };
      const ttsBuffer = await synthesizeSpeech(questionText, ttsOptions);
      const { urlPath } = await saveAudio(sessionId, ttsBuffer, "interviewer", "wav");
      interviewerAudioUrl = urlPath;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.error("[POST /api/voice/turn] TTS timed out — Audio Gateway took too long.");
      } else {
        console.error("[POST /api/voice/turn] TTS error:", err);
      }
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
});

/* ── POST /api/voice/stream ─────────────────────────────────────── */
router.post("/stream", upload.single("audio"), async (req, res) => {
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

    const sessionRows = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, sessionId));

    if (sessionRows.length === 0) {
      sendSseEvent(res, "error", { message: "Session not found" });
      res.end();
      return;
    }

    const session = sessionRows[0];

    if (session.mode !== "voice") {
      sendSseEvent(res, "error", { message: "Session is not in voice mode" });
      res.end();
      return;
    }

    if (session.status === "completed") {
      sendSseEvent(res, "error", { message: "Interview has already concluded" });
      res.end();
      return;
    }

    const audioExt = audioFile.mimetype === "audio/wav" ? "wav" : "webm";
    const audioBuffer = audioFile.buffer;
    const { filePath: candidateAudioPath, urlPath: candidateAudioUrl } = await saveAudio(
      sessionId,
      audioBuffer,
      "candidate",
      audioExt
    );

    let transcription: string;
    let sttConfidence: number | undefined;
    try {
      const sttResult = await transcribeAudio(candidateAudioPath);
      transcription = sttResult.text;
      sttConfidence = sttResult.confidence;
    } catch (err) {
      console.error("[POST /api/voice/stream] STT error:", err);
      sendSseEvent(res, "error", { message: "Failed to transcribe audio. Please try again." });
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

    if (newTurn >= session.maxTurns) {
      await db
        .update(interviewSessions)
        .set({ status: "completed", currentTurn: newTurn, completedAt: new Date() })
        .where(eq(interviewSessions.id, sessionId));

      const completionText = "Thank you, the interview is complete.";

      let interviewerAudioUrl: string | undefined;
      try {
        const ttsOptions: SynthesizeOptions = {
          engine: (session.ttsProvider as "kokoro" | "piper") || "kokoro",
          signal: abortController.signal,
        };
        const ttsBuffer = await synthesizeSpeechWithFallback(completionText, ttsOptions, 0, abortController.signal);
        const { urlPath } = await saveAudio(sessionId, ttsBuffer, "interviewer", "wav");
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
      engine: (session.ttsProvider as "kokoro" | "piper") || "kokoro",
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
          const { urlPath } = await saveAudio(
            sessionId,
            buffer,
            `interviewer-chunk-${idx}`,
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

          const allSentences = splitSentences(stripMarkdown(accumulatedText));
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
      await cleanupSavedAudio(savedUrls);
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
      await cleanupSavedAudio(savedUrls);
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
          const { urlPath } = await saveAudio(sessionId, combinedBuffer, "interviewer", "wav");
          interviewerAudioUrl = urlPath;
          combinedFormat = "wav";
        } else {
          const fmt = detectAudioFormat(validBuffers[0]);
          const { urlPath } = await saveAudio(sessionId, validBuffers[0], "interviewer", fmt);
          interviewerAudioUrl = urlPath;
          combinedFormat = fmt;
        }
      } catch (err) {
        console.error("[POST /api/voice/stream] Audio concat error:", err);
      }
    }

    const interviewerMsgRows = await db
      .insert(messages)
      .values({
        sessionId,
        role: "interviewer",
        content: fullText,
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
      fullText,
      audioUrl: interviewerAudioUrl || null,
    });

    res.end();
  } catch (err) {
    console.error("[POST /api/voice/stream] UNEXPECTED ERROR:", err);
    await cleanupSavedAudio(savedUrls);
    try {
      sendSseEvent(res, "error", {
        message: err instanceof Error ? err.message : "Failed to process voice turn",
      });
    } catch {
      // Stream may already be closed
    }
    res.end();
  }
});

/* ── POST /api/voice/speak ──────────────────────────────────────── */
router.post("/speak", async (req, res) => {
  try {
    const { text, voice, engine } = req.body as {
      text?: string;
      voice?: string;
      engine?: "kokoro" | "piper";
    };

    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const cleanText = stripMarkdown(text);
    const audioBuffer = await synthesizeSpeech(cleanText, { engine, voice });

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(audioBuffer.length));
    res.send(audioBuffer);
  } catch (err) {
    console.error("[POST /api/voice/speak] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "TTS failed" });
  }
});

/* ── POST /api/voice/speak-stream ───────────────────────────────── */
router.post("/speak-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Track generated chunk files so we can delete them if the client disconnects.
  const savedUrls: string[] = [];

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
    const { text, engine, sessionId } = req.body as {
      text?: string;
      engine?: "kokoro" | "piper";
      sessionId?: string;
    };

    if (!text || typeof text !== "string") {
      sendSseEvent(res, "error", { message: "text is required" });
      res.end();
      return;
    }

    const sid = sessionId || "transcript";
    const cleanText = stripMarkdown(text);
    const sentences = splitSentences(cleanText);

    if (sentences.length === 0) {
      sendSseEvent(res, "done", {});
      res.end();
      return;
    }

    const ttsOptions: SynthesizeOptions = { engine, signal: abortController.signal };
    let chunkIndex = 0;

    for (const sentenceText of sentences) {
      for (const chunk of splitForTTS(sentenceText)) {
        if (res.writableEnded || abortController.signal.aborted) {
          await cleanupSavedAudio(savedUrls);
          return;
        }

        const results: SynthesizeResult[] = await synthesizeChunkWithFallback(
          chunk,
          ttsOptions,
          sid,
          chunkIndex,
          0,
          abortController.signal
        );

        if (res.writableEnded || abortController.signal.aborted) {
          for (const result of results) {
            if (result.urlPath) savedUrls.push(result.urlPath);
          }
          await cleanupSavedAudio(savedUrls);
          return;
        }

        if (results.length === 0) {
          sendSseEvent(res, "sentence", {
            index: chunkIndex,
            text: chunk,
            audioUrl: null,
          });
          chunkIndex++;
        } else {
          for (const result of results) {
            if (result.urlPath) savedUrls.push(result.urlPath);
            sendSseEvent(res, "sentence", {
              index: chunkIndex,
              text: result.text,
              audioUrl: result.urlPath,
            });
            chunkIndex++;
          }
        }
      }
    }

    sendSseEvent(res, "done", {});
    res.end();
  } catch (err) {
    console.error("[POST /api/voice/speak-stream] error:", err);
    await cleanupSavedAudio(savedUrls);
    try {
      sendSseEvent(res, "error", {
        message: err instanceof Error ? err.message : "Failed to synthesize speech",
      });
    } catch {
      // Stream may already be closed
    }
    res.end();
  }
});

export default router;

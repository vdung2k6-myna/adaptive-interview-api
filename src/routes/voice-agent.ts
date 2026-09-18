import { Router, type Response } from "express";
import multer from "multer";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildVoiceAgentPrompt, trimVoiceAgentHistory, type VoiceAgentMessage } from "@/lib/prompts";
import { generateChatResponse, generateChatResponseStream } from "@/lib/ollama";
import { OllamaError } from "@/lib/errors";
import { searchKnowledge } from "@/lib/knowledge";
import {
  transcribeAudio,
  synthesizeSpeechWithFallback,
  resolveVoice,
  resolveEngineForLanguage,
  hasUnclosedCodeFence,
  SentenceExtractor,
  type SynthesizeOptions,
} from "@/lib/audio";

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

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

router.post("/stream", upload.single("audio"), async (req, res) => {
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

    let userText = "";
    if (audioFile) {
      const audioExt = audioFile.mimetype === "audio/wav" ? "wav" : "webm";
      await withTempAudioFile(audioFile.buffer, audioExt, async (tmpPath) => {
        const sttResult = await transcribeAudio(tmpPath);
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

    // Knowledge retrieval: bias query with enabled topics when present
    const enabledTopics = parseEnabledTopics(req.body.enabledTopics);
    let knowledgeChunks: Awaited<ReturnType<typeof searchKnowledge>> = [];
    if (enabledTopics.length && userText) {
      const biasedQuery = `${enabledTopics.join(" ")} ${userText}`;
      console.log(`[VoiceAgent] Knowledge query: "${biasedQuery}"`);
      knowledgeChunks = await searchKnowledge(biasedQuery, 3);
      if (knowledgeChunks.length) {
        console.log(
          `[VoiceAgent] Retrieved ${knowledgeChunks.length} knowledge chunk(s)`
        );
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

    const { stream: llmStream, getFullText } = generateChatResponseStream({
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
    let ttsIndex = 0;

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
          for (const chunk of chunks) {
            if (abortController.signal.aborted) break;
            let buffer: Buffer | null = null;
            try {
              buffer = await synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal);
            } catch (err) {
              if (err instanceof Error && err.name === "AbortError") break;
              console.error(`[VoiceAgent] TTS failed chunk ${ttsIndex}:`, err);
            }
            if (!abortController.signal.aborted) {
              sendSseEvent(res, "sentence", {
                index: ttsIndex,
                text: chunk,
                audioData: buffer ? buffer.toString("base64") : null,
              });
            }
            ttsIndex++;
          }
        }
      }

      // Some cloud models (e.g. kimi-k2.6:cloud) stream with empty content
      // but return full text in non-streaming mode. Fall back when streaming
      // yielded nothing.
      let finalText = getFullText();
      if (streamEmpty || !finalText.trim()) {
        console.log("[VoiceAgent] Streaming yielded no text; falling back to non-streaming generateChatResponse");
        finalText = await generateChatResponse({ messages: prompt, temperature: 0.7, repeat_penalty: 1.2 });
      }

      const tailSentences = extractor.finalize(finalText);
      for (const { clean, chunks } of tailSentences) {
        if (abortController.signal.aborted) break;
        sendSseEvent(res, "text", { text: clean });
        console.log(`[VoiceAgent] TTS sentence scheduled: "${clean.substring(0, 80)}" → ${chunks.length} chunk(s)`);
        for (const chunk of chunks) {
          if (abortController.signal.aborted) break;
          let buffer: Buffer | null = null;
          try {
            buffer = await synthesizeSpeechWithFallback(chunk, ttsOptions, 0, abortController.signal);
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") break;
            console.error(`[VoiceAgent] TTS failed chunk ${ttsIndex}:`, err);
          }
          if (!abortController.signal.aborted) {
            sendSseEvent(res, "sentence", {
              index: ttsIndex,
              text: chunk,
              audioData: buffer ? buffer.toString("base64") : null,
            });
          }
          ttsIndex++;
        }
      }

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
});

export default router;

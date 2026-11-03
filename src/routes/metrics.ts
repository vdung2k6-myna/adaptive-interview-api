import { Router } from "express";
import { synthesisQueueStats } from "@/lib/audio/client";
import { transcriptionQueueStats } from "@/lib/audio/stt";
import { modelQueueStats } from "@/lib/ollama";

/**
 * The queues a busy process builds, for an operator asking "busy or broken?".
 *
 * Counts only. Prompt text, audio, provider names and credentials are not queue
 * state, and a reader of this route is told how much work is waiting, not what it
 * says. The route is mounted under `/api`, so the platform's credential guards it
 * exactly as every other API route is guarded.
 */
export function createMetricsRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.json({
      ollama: modelQueueStats(),
      stt: transcriptionQueueStats(),
      tts: synthesisQueueStats(),
    });
  });
  return router;
}

export default createMetricsRouter();

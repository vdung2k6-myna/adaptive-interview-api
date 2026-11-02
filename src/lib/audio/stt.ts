/**
 * Speech-to-text wrapper around audio.cpp.
 * Provides a simple interface for transcribing audio files.
 */

import config from "@/lib/config";
import { createSemaphore } from "@/lib/semaphore";
import { audioClient, type ProviderTarget, type TranscriptionResult } from "./client";

/**
 * The transcription bound, separate from the model's.
 *
 * A burst used to open one request per turn and let each burn its 60 s timeout while
 * the engine worked through them; the same burst now waits here, in arrival order,
 * before a request is sent. The bound is the deployment's STT instance count, so the
 * queue sits where it can be observed and cancelled rather than inside the engine.
 */
const transcriptionSlots = createSemaphore(config.audio.transcriptionConcurrency);

/** The slice of the audio client this wrapper needs, so a test can be a client too. */
interface TranscriptionClient {
  transcribe(
    audioPath: string,
    model?: string,
    language?: string,
    target?: ProviderTarget,
    signal?: AbortSignal
  ): Promise<TranscriptionResult>;
}

/** How many transcriptions are in flight and waiting, for the metrics route. */
export function transcriptionQueueStats(): { inFlight: number; waiting: number } {
  return { inFlight: transcriptionSlots.inFlight(), waiting: transcriptionSlots.waiting() };
}

/**
 * Transcribe an audio file to text.
 * @param audioPath Absolute path to the audio file.
 * @param model Optional STT model override.
 * @param language Optional ISO-639-1 code to decode in. Omit it only when the
 * language genuinely is not known: the service then detects one, and on the audio
 * this product takes its detection misfires on Vietnamese (see
 * `resolveSttLanguage`).
 * @param target The profile's endpoint and key, when the turn names one. Absent
 * means the deployment's own audio.cpp service.
 * @param signal The turn's signal. A queued request leaves the queue when the turn
 * it belongs to ends.
 * @returns Transcription text and optional confidence score.
 */
export async function transcribeAudio(
  audioPath: string,
  model?: string,
  language?: string,
  target?: ProviderTarget,
  signal?: AbortSignal,
  client: TranscriptionClient = audioClient
): Promise<TranscriptionResult> {
  // Acquired before the request is built, so the request's own 60 s timeout starts
  // when it is sent rather than while it waits for its turn at the bound.
  const release = await transcriptionSlots.acquire(signal);
  try {
    return await client.transcribe(audioPath, model, language, target, signal);
  } finally {
    release();
  }
}

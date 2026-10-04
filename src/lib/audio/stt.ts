/**
 * Speech-to-text wrapper around audio.cpp.
 * Provides a simple interface for transcribing audio files.
 */

import { audioClient, type TranscriptionResult } from "./client";

/**
 * Transcribe an audio file to text.
 * @param audioPath Absolute path to the audio file.
 * @param model Optional STT model override.
 * @param language Optional ISO-639-1 code to decode in. Omit it only when the
 * language genuinely is not known: the service then detects one, and on the audio
 * this product takes its detection misfires on Vietnamese (see
 * `resolveSttLanguage`).
 * @returns Transcription text and optional confidence score.
 */
export async function transcribeAudio(
  audioPath: string,
  model?: string,
  language?: string
): Promise<TranscriptionResult> {
  return audioClient.transcribe(audioPath, model, language);
}

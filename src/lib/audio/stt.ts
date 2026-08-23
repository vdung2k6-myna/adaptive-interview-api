/**
 * Speech-to-text wrapper around audio.cpp.
 * Provides a simple interface for transcribing audio files.
 */

import { audioClient, type TranscriptionResult } from "./client";

/**
 * Transcribe an audio file to text.
 * @param audioPath Absolute path to the audio file.
 * @param model Optional STT model override.
 * @returns Transcription text and optional confidence score.
 */
export async function transcribeAudio(
  audioPath: string,
  model?: string
): Promise<TranscriptionResult> {
  return audioClient.transcribe(audioPath, model);
}

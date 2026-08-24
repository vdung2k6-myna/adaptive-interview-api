/**
 * Text-to-speech wrapper around the Audio Gateway.
 * Provides simple and parallel sentence-level synthesis.
 */

import { audioGateway, type SynthesizeOptions } from "./client";

/**
 * Synthesize text into an audio buffer.
 * @param text The text to speak.
 * @param options Optional engine, voice overrides, and abort signal.
 * @returns Audio buffer (WAV format).
 */
export async function synthesizeSpeech(
  text: string,
  options?: SynthesizeOptions
): Promise<Buffer> {
  return audioGateway.synthesize(text, options);
}

/**
 * Synthesize multiple sentences in parallel with a concurrency limit.
 * Returns results sorted by original index.
 *
 * @param sentences Array of text sentences.
 * @param options Optional engine and voice overrides.
 * @returns Array of { index, buffer, text } sorted by index.
 */
export async function synthesizeSentences(
  sentences: string[],
  options?: SynthesizeOptions
): Promise<{ index: number; buffer: Buffer; text: string }[]> {
  const concurrency = 3;
  const results: { index: number; buffer: Buffer; text: string }[] = [];

  for (let i = 0; i < sentences.length; i += concurrency) {
    const batch = sentences.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (sentenceText, batchIdx) => {
        const buffer = await audioGateway.synthesize(sentenceText, options);
        return { index: i + batchIdx, buffer, text: sentenceText };
      })
    );
    results.push(...batchResults);
  }

  return results.sort((a, b) => a.index - b.index);
}

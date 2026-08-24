/**
 * Shared text processing utilities for TTS pipelines.
 *
 * Provides:
 * - stripMarkdown: Remove markdown formatting for clean TTS input
 * - splitForTTS: Split long text into phoneme-safe chunks
 * - synthesizeSpeechWithFallback: Recursive retry on phoneme overflow
 * - synthesizeChunkWithFallback: Wrapper that saves audio after synthesis
 */

import { synthesizeSpeech } from "./tts";
import { saveAudio, detectAudioFormat } from "./storage";
import { concatWavBuffers } from "./wav-utils";
import type { SynthesizeOptions } from "./client";

export interface SynthesizeResult {
  urlPath: string;
  text: string;
}

/**
 * Return true if the text contains at least one Unicode letter.
 * Piper/Kokoro need real words to synthesize; pure punctuation or
 * whitespace-only strings will fail with "produced no audio data".
 */
function hasSynthesizableContent(text: string): boolean {
  return /\p{L}/u.test(text);
}

/**
 * Strip markdown formatting markers from text before TTS.
 *
 * Handles:
 * - Fenced code blocks (```...```) → "code example"
 * - Inline code (`code`) → code (backticks removed, content kept)
 * - Bold (**text**) → text
 * - Underline (__text__) → text
 * - Italic (*text*) → text
 * - Italic (_text_) → text
 * - Headers (# Title) → Title
 * - Blockquotes (> text) → text
 * - List items (- item, * item, 1. item) → item
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // Fenced code blocks: replace entire block with placeholder
      .replace(/```[\s\S]*?```/g, " code example ")
      // Inline code: keep content, remove backticks
      .replace(/`([^`]+)`/g, "$1")
      // Bold
      .replace(/\*\*(.*?)\*\*/g, "$1")
      // Underline
      .replace(/__(.*?)__/g, "$1")
      // Italic (must run after bold/underline)
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/_(.*?)_/g, "$1")
      // Headers: remove leading # markers
      .replace(/^#{1,6}\s+/gm, "")
      // Blockquotes
      .replace(/^>\s?/gm, "")
      // Unordered list items
      .replace(/^[-*]\s+/gm, "")
      // Ordered list items
      .replace(/^\d+\.\s+/gm, "")
      // Collapse all newlines (single and double) to spaces.
      // We do not try to preserve paragraph breaks here because
      // splitSentences cannot distinguish a paragraph break from a
      // regular sentence boundary after stripping. Sentence-ending
      // punctuation (handled by getPauseMs in the audio queue) provides
      // the natural pause between paragraphs.
      .replace(/\n/g, " ")
      // Collapse multiple whitespace characters
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Split a long sentence into smaller chunks safe for TTS engines.
 *
 * Piper and Kokoro both have a max phoneme limit (~510). Vietnamese averages
 * ~6 phonemes/char, so a safe chunk size is ~60 characters to leave headroom.
 *
 * Boundary preference (strongest first):
 * 1. Colons and semicolons — natural clause boundaries
 * 2. Commas — phrase boundaries
 * 3. Spaces — word boundaries
 * 4. Hard split at maxChars — last resort
 *
 * The algorithm scores every boundary in the search range and picks the one
 * closest to maxChars, with only a small bonus for stronger boundaries. This
 * prevents a colon at position 5 from producing a 5-char fragment when a
 * space at position 58 would give a much more natural chunk.
 *
 * @param text The text to split.
 * @param maxChars Maximum characters per chunk (default: 60).
 * @returns Array of chunks.
 */
export function splitForTTS(text: string, maxChars = 60): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text.trim();
  const minChunkSize = Math.max(20, Math.floor(maxChars / 3));

  while (remaining.length > maxChars) {
    let bestAt = -1;
    let bestScore = -1;

    // Single backward pass: score every boundary in the preferred range
    for (let i = maxChars; i >= minChunkSize; i--) {
      const ch = remaining[i];
      let score = i;

      if (ch === ":" || ch === ";") {
        score += 15; // small bonus for strong boundary
      } else if (ch === ",") {
        score += 8; // smaller bonus for comma
      } else if (ch === " ") {
        score += 0; // no bonus for space
      } else {
        continue; // not a boundary
      }

      if (score > bestScore) {
        bestScore = score;
        bestAt = i;
      }
    }

    let splitAt = bestAt;

    // Fallback: if no boundary in preferred range, search all the way to start
    if (splitAt === -1) {
      for (let i = minChunkSize; i >= 0; i--) {
        if (remaining[i] === " ") {
          splitAt = i;
          break;
        }
      }
    }

    // Last resort: hard split at maxChars
    if (splitAt === -1) {
      splitAt = maxChars;
    }

    // For colon/semicolon/comma, include them in the first chunk.
    // For space, split at the space (don't include it).
    const isSpace = remaining[splitAt] === " ";
    const cut = isSpace ? splitAt : splitAt + 1;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Attempt to synthesize text. If the TTS engine fails with a phoneme overflow
 * error, recursively split the text in half and retry each half.
 *
 * When both halves succeed and are WAV format, they are concatenated into a
 * single buffer so no audio is lost.
 *
 * @param text The text to synthesize.
 * @param ttsOptions Engine, voice, and optional abort signal.
 * @param depth Recursion depth (max 3).
 * @param signal Optional abort signal; if aborted, recursion stops early.
 * @returns Audio buffer.
 * @throws If synthesis fails and cannot be recovered.
 */
export async function synthesizeSpeechWithFallback(
  text: string,
  ttsOptions: SynthesizeOptions,
  depth = 0,
  signal?: AbortSignal
): Promise<Buffer> {
  if (signal?.aborted) {
    throw new DOMException("TTS synthesis aborted", "AbortError");
  }

  if (depth > 3) {
    throw new Error(
      `Max TTS recursion depth reached for chunk "${text.slice(0, 30)}..."`
    );
  }

  // Skip pure punctuation / whitespace chunks silently.
  if (!hasSynthesizableContent(text)) {
    throw new Error(`No synthesizable content: "${text.slice(0, 30)}"`);
  }

  try {
    return await synthesizeSpeech(text, { ...ttsOptions, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }

    const isPhonemeError =
      msg.includes("Piper produced no audio data") ||
      msg.includes("Phoneme chunk too long");

    if (isPhonemeError && text.length > 15) {
      console.warn(
        `[synthesizeSpeechWithFallback] Retrying split for chunk "${text.slice(0, 40)}..." (depth=${depth})`
      );

      const mid = Math.floor(text.length / 2);
      let splitAt = mid;
      for (let i = mid; i >= mid - 10 && i >= 0; i--) {
        if (text[i] === " ") {
          splitAt = i;
          break;
        }
      }

      const left = text.slice(0, splitAt).trim();
      const right = text.slice(splitAt).trim();

      if (left && right) {
        if (signal?.aborted) {
          throw new DOMException("TTS synthesis aborted", "AbortError");
        }
        const leftBuf = await synthesizeSpeechWithFallback(
          left,
          ttsOptions,
          depth + 1,
          signal
        );
        if (signal?.aborted) {
          throw new DOMException("TTS synthesis aborted", "AbortError");
        }
        const rightBuf = await synthesizeSpeechWithFallback(
          right,
          ttsOptions,
          depth + 1,
          signal
        );

        // If both halves are WAV, concatenate so no audio is lost
        const leftWav = leftBuf.length >= 4 && leftBuf.toString("ascii", 0, 4) === "RIFF";
        const rightWav = rightBuf.length >= 4 && rightBuf.toString("ascii", 0, 4) === "RIFF";

        if (leftWav && rightWav) {
          return concatWavBuffers([leftBuf, rightBuf]);
        }

        // For non-WAV formats (e.g. MP3), return the left half only.
        // The right half is lost in this case — this is a known limitation.
        return leftBuf;
      }
    }

    throw err;
  }
}

/**
 * Synthesize a single chunk with fallback, then save the audio to disk.
 *
 * If the chunk fails with a phoneme overflow, it is recursively split and
 * each successful sub-chunk is saved separately. This ensures no text is lost
 * (previous implementation only returned one half).
 *
 * @param chunk The text chunk to synthesize.
 * @param ttsOptions Engine, voice, and optional abort signal.
 * @param sessionId Session identifier for audio storage.
 * @param chunkIndex Index used as part of the filename prefix.
 * @param depth Recursion depth (max 3).
 * @param signal Optional abort signal; if aborted, skip saving and return empty.
 * @returns Array of saved results (may contain multiple entries if split).
 */
export async function synthesizeChunkWithFallback(
  chunk: string,
  ttsOptions: SynthesizeOptions,
  sessionId: string,
  chunkIndex: number,
  depth = 0,
  signal?: AbortSignal
): Promise<SynthesizeResult[]> {
  if (depth > 3) {
    console.warn(
      `[synthesizeChunkWithFallback] Max depth reached for chunk "${chunk.slice(0, 30)}..."`
    );
    return [];
  }

  // Skip pure punctuation / whitespace chunks silently — TTS engines
  // cannot synthesize them and will return "produced no audio data".
  if (!hasSynthesizableContent(chunk)) {
    return [];
  }

  if (signal?.aborted) {
    return [];
  }

  try {
    const buffer = await synthesizeSpeech(chunk, { ...ttsOptions, signal });
    if (signal?.aborted) {
      return [];
    }
    const fmt = detectAudioFormat(buffer);
    const { urlPath } = await saveAudio(
      sessionId,
      buffer,
      `speak-chunk-${chunkIndex}`,
      fmt
    );
    return [{ urlPath, text: chunk }];
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return [];
    }

    const msg = err instanceof Error ? err.message : String(err);
    const isPhonemeError =
      msg.includes("Piper produced no audio data") ||
      msg.includes("Phoneme chunk too long");

    if (isPhonemeError && chunk.length > 15) {
      console.warn(
        `[synthesizeChunkWithFallback] Retrying split for chunk "${chunk.slice(0, 40)}..." (depth=${depth})`
      );

      const mid = Math.floor(chunk.length / 2);
      let splitAt = mid;
      for (let i = mid; i >= mid - 10 && i >= 0; i--) {
        if (chunk[i] === " ") {
          splitAt = i;
          break;
        }
      }

      const left = chunk.slice(0, splitAt).trim();
      const right = chunk.slice(splitAt).trim();

      if (left && right) {
        if (signal?.aborted) {
          return [];
        }
        const leftResults = await synthesizeChunkWithFallback(
          left,
          ttsOptions,
          sessionId,
          chunkIndex,
          depth + 1,
          signal
        );
        if (signal?.aborted) {
          return [];
        }
        const rightResults = await synthesizeChunkWithFallback(
          right,
          ttsOptions,
          sessionId,
          chunkIndex,
          depth + 1,
          signal
        );
        return [...leftResults, ...rightResults];
      }
    }

    // Short chunks that still fail, or non-phoneme errors — log once
    console.warn(`[synthesizeChunkWithFallback] TTS failed (len=${chunk.length}): ${msg}`);
    return [];
  }
}

/**
 * Shared text processing utilities for TTS pipelines.
 *
 * Provides:
 * - stripMarkdown: Remove markdown formatting for clean TTS input
 * - normalizeNumbersForKokoro: Convert Arabic numerals to Vietnamese words
 * - splitForTTS: Split long text into phoneme-safe chunks
 * - synthesizeSpeechWithFallback: Recursive retry on phoneme overflow
 * - synthesizeChunkWithFallback: Wrapper that saves audio after synthesis
 */

import { synthesizeSpeech } from "./tts";
import { saveAudio, detectAudioFormat } from "./storage";
import { concatWavBuffers } from "./wav-utils";
import { splitSentences } from "./split-sentences";
import type { SynthesizeOptions } from "./client";

export interface SynthesizeResult {
  urlPath: string;
  text: string;
}

/**
 * Options for synthesizing long text into a single combined audio clip.
 * Extends the standard TTS options with optional session/prefix for saving.
 */
export interface SynthesizeLongTextOptions extends SynthesizeOptions {
  /** Session identifier used when saving the combined audio file. */
  sessionId?: string;
  /** Filename prefix when saving (default: "speech"). */
  prefix?: string;
}

/**
 * Result of synthesizing long text: the combined audio buffer and, when a
 * sessionId was provided, the URL path where it was saved.
 */
export interface SynthesizeLongTextResult {
  buffer: Buffer;
  urlPath?: string;
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

// ── Vietnamese number normalization ─────────────────────────────────────

const DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

/**
 * Convert a number in the range 0..999 into Vietnamese words.
 */
function readThreeDigits(n: number, pad = false): string {
  if (n === 0 && !pad) return "";

  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  const tens = Math.floor(remainder / 10);
  const ones = remainder % 10;

  const parts: string[] = [];
  if (hundreds > 0) {
    parts.push(DIGITS[hundreds], "trăm");
  } else if (pad) {
    parts.push("không", "trăm");
  }

  if (remainder > 0) {
    if ((hundreds > 0 || pad) && tens === 0 && ones > 0) {
      parts.push("linh");
    }

    if (tens > 1) {
      parts.push(DIGITS[tens], "mươi");
      if (ones === 1) {
        parts.push("mốt");
      } else if (ones === 4) {
        parts.push("tư");
      } else if (ones === 5) {
        parts.push("lăm");
      } else if (ones > 0) {
        parts.push(DIGITS[ones]);
      }
    } else if (tens === 1) {
      parts.push("mười");
      if (ones === 5) {
        parts.push("lăm");
      } else if (ones > 0) {
        parts.push(DIGITS[ones]);
      }
    } else if (tens === 0 && ones > 0) {
      parts.push(DIGITS[ones]);
    }
  }

  return parts.join(" ");
}

/**
 * Convert a non-negative integer (0..999,999,999,999) to Vietnamese words.
 *
 * @param n A non-negative integer.
 * @returns The Vietnamese reading of the number.
 * @throws RangeError if n is negative, non-integer, or exceeds 999,999,999,999.
 */
export function numberToVietnameseWords(n: number): string {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new RangeError(`numberToVietnameseWords expects a non-negative integer, got ${n}`);
  }
  if (n > 999_999_999_999) {
    throw new RangeError("numberToVietnameseWords supports numbers up to 999,999,999,999");
  }

  if (n === 0) return "không";

  const chunks: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    chunks.push(remaining % 1000);
    remaining = Math.floor(remaining / 1000);
  }

  const scales = ["", "nghìn", "triệu", "tỷ"];

  const parts: string[] = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk === 0) continue;

    // Non-highest chunks that are < 100 need a leading "không trăm" so the
    // missing hundreds place is pronounced (e.g., 1,005 → "một nghìn không
    // trăm linh năm").
    const isMostSignificant = i === chunks.length - 1;
    const chunkWords = readThreeDigits(chunk, !isMostSignificant && chunk < 100);
    if (chunkWords) {
      parts.push(chunkWords);
      if (scales[i]) {
        parts.push(scales[i]);
      }
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Convert a sequence of digits into Vietnamese digit-by-digit words.
 * Used for codes, version segments, and other cases where reading the value
 * would be unnatural (e.g., "0909" should not become "chín trăm linh chín").
 */
function digitsToWords(text: string): string {
  return text
    .split("")
    .map((ch) => DIGITS[parseInt(ch, 10)])
    .join(" ");
}

/**
 * Heuristic: should this digit sequence be read as a number value rather than
 * digit-by-digit? True for short natural numbers; false for long sequences
 * that look like phone numbers, codes, or version segments.
 */
function shouldReadAsValue(digits: string): boolean {
  // 1-4 digit numbers are read as values (covers years, experience, simple counts).
  // 5+ digit sequences are read as individual digits (phone, postal codes, etc.).
  return digits.length >= 1 && digits.length <= 4;
}

/**
 * Convert a percentage like "50%" to Vietnamese words.
 */
function normalizePercentage(match: string): string {
  const digits = match.slice(0, -1); // remove trailing %
  if (!/^\d+$/.test(digits)) return match;
  return `${numberToVietnameseWords(parseInt(digits, 10))} phần trăm`;
}

/**
 * Convert a simple decimal like "3.14" to Vietnamese words.
 */
function normalizeDecimal(match: string): string {
  const [whole, fraction] = match.split(".");
  if (!/^\d+$/.test(whole) || !/^\d+$/.test(fraction)) return match;
  const wholeWords = numberToVietnameseWords(parseInt(whole, 10));
  const fractionWords = digitsToWords(fraction);
  return `${wholeWords} phẩy ${fractionWords}`;
}

/**
 * Convert a standalone integer to Vietnamese words if it is short enough to read
 * naturally; otherwise read it digit-by-digit.
 */
function normalizeInteger(digits: string): string {
  if (shouldReadAsValue(digits)) {
    return numberToVietnameseWords(parseInt(digits, 10));
  }
  return digitsToWords(digits);
}

// Matches a dotted version or IP-like sequence (e.g., v1.2.3, 192.168.1.1).
const VERSION_OR_IP_RE = /\b[a-zA-Z]*\d+(?:\.\d+){2,}\b/g;

// Matches Vietnamese phone numbers (10-11 digits starting with 0).
const PHONE_RE = /\b0\d{9,10}\b/g;

// Vietnamese letters with diacritics and tone marks.
const VIETNAMESE_CHAR_RE = /[àáảãạâầấẩẫậăằắẳẵặđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i;

/**
 * Return true if the text contains Vietnamese-specific characters.
 * Used as a lightweight language heuristic: if the text has no Vietnamese
 * diacritics, we assume it is English or another language and skip number
 * normalization so digits are not read as Vietnamese words.
 */
function isVietnameseText(text: string): boolean {
  return VIETNAMESE_CHAR_RE.test(text);
}

/**
 * Convert Arabic numerals in text to Vietnamese words, suitable for the
 * Vietnamese Kokoro TTS engine.
 *
 * Rules:
 * - Only runs when the text appears to be Vietnamese (contains diacritics).
 * - Standalone integers 1-4 digits are read as natural numbers (e.g., 3 → ba).
 * - Longer digit sequences are read digit-by-digit.
 * - Percentages (50%) are expanded.
 * - Simple decimals (3.14) are expanded.
 * - Dotted version/IP-like strings and phone numbers are left untouched.
 */
export function normalizeNumbersForKokoro(text: string): string {
  if (!text || !isVietnameseText(text)) return text;

  // Protect dotted version/IP-like sequences and phone numbers by masking them.
  const protectedRanges: Array<{ start: number; end: number }> = [];
  for (const re of [VERSION_OR_IP_RE, PHONE_RE]) {
    for (const match of text.matchAll(re)) {
      protectedRanges.push({ start: match.index!, end: match.index! + match[0].length });
    }
  }

  function isProtected(start: number, end: number): boolean {
    return protectedRanges.some((r) => start < r.end && end > r.start);
  }

  // Percentages first (must match before standalone integers).
  text = text.replace(/\d+%/g, (match, offset) => {
    if (isProtected(offset, offset + match.length)) return match;
    return normalizePercentage(match);
  });

  // Decimals next.
  text = text.replace(/\d+\.\d+/g, (match, offset) => {
    if (isProtected(offset, offset + match.length)) return match;
    return normalizeDecimal(match);
  });

  // Standalone integers last.
  text = text.replace(/\d+/g, (match, offset) => {
    if (isProtected(offset, offset + match.length)) return match;
    return normalizeInteger(match);
  });

  return text;
}

/**
 * Apply engine-specific text normalization.
 *
 * Kokoro (Vietnamese) needs Arabic numerals converted to words so the model can
 * pronounce them. Piper and other engines receive the original text unchanged.
 */
export function normalizeTextForEngine(text: string, engine?: string): string {
  const normalized = stripMarkdown(text);
  if ((engine ?? "kokoro") === "kokoro") {
    return normalizeNumbersForKokoro(normalized);
  }
  return normalized;
}

/**
 * Vietnamese words that commonly start a new clause/phrase. Splitting before
 * them usually sounds natural (e.g., "cho", "với", "nào").
 */
const VIETNAMESE_PHRASE_STARTERS = new Set([
  "nào", "để", "và", "hoặc", "nhưng", "vì", "với", "trong", "tại", "bởi",
  "khi", "nếu", "cho", "theo", "từ", "đến", "qua", "về", "dưới", "trên",
  "ngoài", "giữa", "sau", "trước", "bên",
]);

/**
 * Two-word Vietnamese phrases that strongly indicate a natural clause break.
 * These get a higher bonus than single-word starters.
 */
const VIETNAMESE_PHRASE_PAIRS = new Set([
  "cụ thể",
  "ví dụ",
  "bởi vì",
  "mặc dù",
  "tuy nhiên",
  "do đó",
  "vì vậy",
  "ngoài ra",
  "trong khi",
  "khi mà",
  "nếu như",
  "sau khi",
  "trước khi",
]);

const WORD_RE =
  /^[a-zA-Zàáảãạâầấẩẫậăằắẳẵặđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]+/i;

/**
 * Return the first two whitespace-delimited tokens that follow the given index,
 * lowercased. Used to detect Vietnamese phrase-pair boundaries.
 */
function nextTwoWords(text: string, index: number): [string, string] {
  let tail = text.slice(index + 1).trimStart();
  const firstMatch = tail.match(WORD_RE);
  const first = firstMatch ? firstMatch[0].toLowerCase() : "";
  tail = tail.slice(first.length).trimStart();
  const secondMatch = tail.match(WORD_RE);
  const second = secondMatch ? secondMatch[0].toLowerCase() : "";
  return [first, second];
}

/**
 * Split a long sentence into smaller chunks safe for TTS engines.
 *
 * Piper and Kokoro both have a max phoneme limit (~510). Vietnamese averages
 * ~6 phonemes/char, so a safe chunk size is ~60 characters to leave headroom.
 *
 * Boundary preference (strongest first):
 * 1. Vietnamese two-word phrase boundaries (e.g., "cụ thể")
 * 2. Colons and semicolons — natural clause boundaries
 * 3. Commas — phrase boundaries
 * 4. Vietnamese single phrase-start words (e.g., "cho", "với") — clause boundaries
 * 5. Spaces — word boundaries
 * 6. Hard split at maxChars — last resort
 *
 * The algorithm balances distance from the ideal maxChars with boundary
 * strength. Stronger boundaries (especially two-word phrase pairs) can win
 * even when significantly earlier, which prevents unnatural splits like
 * separating a number from its noun ("cho 5" / "người lớn tuổi").
 *
 * @param text The text to split.
 * @param maxChars Maximum characters per chunk (default: 60).
 * @returns Array of chunks.
 */
export function splitForTTS(text: string, maxChars = 60): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text.trim();

  // Hard floor: never produce chunks shorter than 10 chars.
  // Soft floor: weak boundaries (plain spaces) should stay above ~maxChars/3.
  const hardMin = 10;
  const softMin = Math.max(20, Math.floor(maxChars / 3));

  while (remaining.length > maxChars) {
    let bestAt = -1;
    let bestScore = -Infinity;

    // Search backward from maxChars for the best boundary.
    for (let i = maxChars; i >= hardMin; i--) {
      const ch = remaining[i];
      if (ch !== " " && ch !== ":" && ch !== ";" && ch !== ",") continue;

      const [next, nextNext] = nextTwoWords(remaining, i);
      const phrasePair = `${next} ${nextNext}`;
      const isPhrasePair = VIETNAMESE_PHRASE_PAIRS.has(phrasePair);
      const startsPhrase = VIETNAMESE_PHRASE_STARTERS.has(next);
      const nextIsDigit = /^\d/.test(remaining.slice(i + 1).trimStart());

      // Strong boundaries (punctuation + two-word phrases) may extend below the
      // soft minimum; single-word starters and spaces stay above it.
      const isStrongBoundary =
        ch === ":" || ch === ";" || ch === "," || isPhrasePair;
      if (i < softMin && !isStrongBoundary) continue;

      let score = 0;
      if (isPhrasePair) {
        score += 130; // strongest Vietnamese clause boundary
      } else if (ch === ":" || ch === ";") {
        score += 100;
      } else if (ch === ",") {
        score += 80;
      } else if (startsPhrase) {
        score += 65;
      } else if (ch === " ") {
        score += 10;
      }

      // Avoid splitting right before a number or quantifier.
      if (nextIsDigit) score -= 60;

      // Prefer boundaries close to the target length, but with a modest
      // penalty so earlier strong boundaries can still win.
      score -= Math.abs(i - maxChars) * 0.3;

      if (score > bestScore) {
        bestScore = score;
        bestAt = i;
      }
    }

    let splitAt = bestAt;

    // Fallback: if no boundary scored above the floor, search all the way to
    // the start for any space (but still avoid splitting before digits).
    if (splitAt === -1) {
      for (let i = softMin; i >= 0; i--) {
        if (
          remaining[i] === " " &&
          !/^\d/.test(remaining.slice(i + 1).trimStart())
        ) {
          splitAt = i;
          break;
        }
      }
    }

    // Last resort: hard split at maxChars.
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

  const engine = ttsOptions.engine ?? "kokoro";
  const normalizedText = normalizeTextForEngine(text, engine);

  // Skip pure punctuation / whitespace chunks silently.
  if (!hasSynthesizableContent(normalizedText)) {
    throw new Error(`No synthesizable content: "${normalizedText.slice(0, 30)}"`);
  }

  try {
    return await synthesizeSpeech(normalizedText, { ...ttsOptions, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }

    const isPhonemeError =
      msg.includes("Piper produced no audio data") ||
      msg.includes("Phoneme chunk too long");

    if (isPhonemeError && normalizedText.length > 15) {
      console.warn(
        `[synthesizeSpeechWithFallback] Retrying split for chunk "${normalizedText.slice(0, 40)}..." (depth=${depth})`
      );

      const mid = Math.floor(normalizedText.length / 2);
      let splitAt = mid;
      for (let i = mid; i >= mid - 10 && i >= 0; i--) {
        if (normalizedText[i] === " ") {
          splitAt = i;
          break;
        }
      }

      const left = normalizedText.slice(0, splitAt).trim();
      const right = normalizedText.slice(splitAt).trim();

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

  const engine = ttsOptions.engine ?? "kokoro";
  const normalizedChunk = normalizeTextForEngine(chunk, engine);

  // Skip pure punctuation / whitespace chunks silently — TTS engines
  // cannot synthesize them and will return "produced no audio data".
  if (!hasSynthesizableContent(normalizedChunk)) {
    return [];
  }

  if (signal?.aborted) {
    return [];
  }

  try {
    const buffer = await synthesizeSpeech(normalizedChunk, { ...ttsOptions, signal });
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

    if (isPhonemeError && normalizedChunk.length > 15) {
      console.warn(
        `[synthesizeChunkWithFallback] Retrying split for chunk "${normalizedChunk.slice(0, 40)}..." (depth=${depth})`
      );

      const mid = Math.floor(normalizedChunk.length / 2);
      let splitAt = mid;
      for (let i = mid; i >= mid - 10 && i >= 0; i--) {
        if (normalizedChunk[i] === " ") {
          splitAt = i;
          break;
        }
      }

      const left = normalizedChunk.slice(0, splitAt).trim();
      const right = normalizedChunk.slice(splitAt).trim();

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
    console.warn(`[synthesizeChunkWithFallback] TTS failed (len=${normalizedChunk.length}): ${msg}`);
    return [];
  }
}

/**
 * Synthesize long text into a single combined audio buffer.
 *
 * Normalizes the text, splits it into phoneme-safe chunks, synthesizes each
 * chunk with recursive fallback, and concatenates the resulting WAV buffers.
 * If a sessionId is provided, the combined buffer is saved to disk and the
 * URL path is returned.
 *
 * This is the shared implementation used by the non-streaming voice routes
 * (`/start`, `/turn`, `/speak`) so they are resilient to long Vietnamese
 * prompts after number normalization.
 *
 * @param text The text to synthesize.
 * @param options Engine, voice, optional session/prefix, and abort signal.
 * @param signal Optional abort signal for cancellation.
 * @param synthesizeFn Injectable synthesizer for testing (default: synthesizeSpeechWithFallback).
 * @returns Combined audio buffer and optional saved URL path.
 */
export async function synthesizeLongText(
  text: string,
  options: SynthesizeLongTextOptions,
  signal?: AbortSignal,
  synthesizeFn: (
    text: string,
    options: SynthesizeOptions,
    depth?: number,
    signal?: AbortSignal
  ) => Promise<Buffer> = synthesizeSpeechWithFallback
): Promise<SynthesizeLongTextResult> {
  const engine = options.engine ?? "kokoro";
  const normalizedText = normalizeTextForEngine(text, engine);

  if (!hasSynthesizableContent(normalizedText)) {
    throw new Error(`No synthesizable content: "${normalizedText.slice(0, 30)}"`);
  }

  const sentences = splitSentences(normalizedText);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (hasSynthesizableContent(sentence)) {
      chunks.push(...splitForTTS(sentence));
    }
  }

  if (chunks.length === 0) {
    throw new Error(
      `No synthesizable content after splitting: "${normalizedText.slice(0, 30)}"`
    );
  }

  const buffers: Buffer[] = [];
  for (const chunk of chunks) {
    if (signal?.aborted) {
      throw new DOMException("TTS synthesis aborted", "AbortError");
    }
    const normalizedChunk = normalizeTextForEngine(chunk, engine);
    if (!hasSynthesizableContent(normalizedChunk)) {
      continue;
    }
    const buffer = await synthesizeFn(chunk, options, 0, signal);
    buffers.push(buffer);
  }

  if (buffers.length === 0) {
    throw new Error("No audio was produced for any chunk");
  }

  const allWav = buffers.every(
    (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "RIFF"
  );

  let combinedBuffer: Buffer;
  let fmt: string;
  if (allWav) {
    combinedBuffer =
      buffers.length === 1 ? buffers[0] : concatWavBuffers(buffers);
    fmt = "wav";
  } else {
    // Non-WAV formats cannot be concatenated; keep the first chunk.
    combinedBuffer = buffers[0];
    fmt = detectAudioFormat(combinedBuffer);
  }

  if (options.sessionId) {
    const { urlPath } = await saveAudio(
      options.sessionId,
      combinedBuffer,
      options.prefix || "speech",
      fmt
    );
    return { buffer: combinedBuffer, urlPath, text: normalizedText };
  }

  return { buffer: combinedBuffer, text: normalizedText };
}

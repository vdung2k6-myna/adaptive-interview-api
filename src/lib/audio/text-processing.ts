/**
 * Shared text processing utilities for TTS pipelines.
 *
 * Provides:
 * - stripMarkdown: Remove markdown formatting for clean TTS input
 * - normalizeNumbersForKokoro: Convert Arabic numerals to Vietnamese words
 * - splitForTTS: Split long text into phoneme-safe chunks
 * - synthesizeSpeechWithFallback: Recursive retry by dividing the utterance
 * - synthesizeChunkWithFallback: Wrapper that saves audio after synthesis
 */

import { synthesizeSpeech } from "./tts";
import { saveAudio, deleteAudio, detectAudioFormat } from "./storage";
import { concatWavBuffers } from "./wav-utils";
import { splitSentences } from "./split-sentences";
import type { SynthesizeOptions } from "./client";
import config from "@/lib/config";

/**
 * Return true if the text has an unmatched opening fenced code block marker.
 * Used during streaming TTS to avoid speaking partial fence content (including
 * the language tag) before the closing fence arrives.
 */
export function hasUnclosedCodeFence(text: string): boolean {
  const fenceMatches = text.match(/```/g);
  return !!fenceMatches && fenceMatches.length % 2 === 1;
}

export interface SynthesizeResult {
  urlPath: string;
  text: string;
}

export type InterviewLanguage = "english" | "vietnamese";

/**
 * Resolve the voice ID for a given TTS engine and interview language.
 * Falls back to the configured default voice if no engine-specific voice is set.
 */
export function resolveVoice(
  engine: "kokoro" | "piper" | "supertonic",
  language: InterviewLanguage
): string {
  const voice = config.audio.voices[engine]?.[language]?.trim();
  return voice || config.audio.defaultVoice;
}

/**
 * Resolve the TTS engine to use for a given interview language.
 *
 * Engine ↔ Language mapping is forced at runtime because the deployed voice
 * models are language-specific:
 * - English interviews must use Piper (only English voices are installed there).
 */
export function resolveEngineForLanguage(
  requestedEngine: "kokoro" | "piper" | "supertonic" | undefined,
  language: InterviewLanguage
): "kokoro" | "piper" | "supertonic" {
  if (language === "english") {
    // When a specific engine was requested (including supertonic), honor it.
    // Otherwise fall back to piper for English since kokoro only has Vietnamese voices.
    return requestedEngine ?? "piper";
  }
  return requestedEngine ?? "kokoro";
}

/**
 * The ISO-639-1 code to transcribe in, for an interview language.
 *
 * Tell the service the language or it detects one, and its detection is not to be
 * trusted on this audio. Given a short, quiet, or weakly-onset Vietnamese
 * utterance it decides the person is speaking Chinese, and the LLM is then handed
 * a Chinese sentence nobody said. Measured on the gadget bridge: a turn whose
 * transcript came back "你可就别别说这话了。", reproduced deterministically from the
 * captured audio, which returned clean Vietnamese for the same bytes only when
 * `language=vi` was sent. Pinning it back the other way (`language=en` on that
 * same clip) returns English, so the code is honored rather than merely a hint.
 *
 * The tutor personas turn this from a bad transcript into visible nonsense: fed a
 * Chinese transcript they correct the person's "Chinese", so the device lectures
 * someone who has only ever spoken Vietnamese about a language they never used.
 *
 * The service takes the two-letter lowercase code. The full name ("vietnamese")
 * is not recognized and quietly falls back to detection — the failure this
 * exists to remove — so these must stay ISO codes.
 */
const STT_LANGUAGE_CODES: Record<InterviewLanguage, string> = {
  vietnamese: "vi",
  english: "en",
};

export function resolveSttLanguage(language: InterviewLanguage): string {
  return STT_LANGUAGE_CODES[language];
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
  /** Optional abort signal for cancelling synthesis and cleaning up saved audio. */
  signal?: AbortSignal;
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
 * - Fenced code blocks (```...```) → code content (language tag removed)
 * - Inline code (`code`) → code (backticks removed, content kept)
 * - Bold (**text**) → text
 * - Underline (__text__) → text
 * - Italic (*text*) → text
 * - Italic (_text_) → text
 * - Strikethrough (~~text~~) → text
 * - Headers (# Title) → Title
 * - Blockquotes (> text) → text
 * - List items (- item, * item, 1. item) → item
 * - Links ([text](url)) → text
 * - Images (![alt](url)) → alt text
 * - Horizontal rules (---, ***, ___) → removed
 * - Stray backticks from malformed inline code → removed
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // Empty fenced code blocks (language tag but no content).
      // Some models confuse the interview-language instruction with a code-block
      // language tag and emit ```vietnamese``` or ```english```. Remove them
      // entirely before handling blocks that contain actual code.
      .replace(/```[a-zA-Z0-9_+-]*```/g, "")
      // Fenced code blocks: keep code content, remove fence and optional language tag.
      // The LLM sometimes emits CRLF or literal "\n" after the language tag instead of
      // a plain newline (e.g., ```markdown\r\nWhat is...? or ```markdown\nWhat is...?).
      // Accept all common forms and unescape any remaining "\r", "\n", "\t" literals
      // inside the captured code so they do not get spoken.
      .replace(
        /```(?:[a-zA-Z0-9_+-]*(?:\r\n|\n|\\r\\n|\\n))?([\s\S]*?)```/g,
        (_, code: string) =>
          code
            .replace(/\r/g, " ")
            .replace(/\\r/g, " ")
            .replace(/\\n/g, " ")
            .replace(/\\t/g, " ")
            .trimStart()
      )
      // Horizontal rules (their own line). Run before inline formatting so that
      // lines like "***" are not partially consumed by the italic regex.
      .replace(/^[\s]*[-*_]{3,}[\s]*$/gm, "")
      // Images: keep alt text, drop URL (must run before links so the leading
      // exclamation mark is removed along with the image syntax).
      .replace(/!\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Links: keep link text, drop URL
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Inline code: keep content, remove backticks
      .replace(/`([^`]+)`/g, "$1")
      // Strikethrough (must run before bold/italic because it uses ~)
      .replace(/~~(.*?)~~/g, "$1")
      // Bold
      .replace(/\*\*(.*?)\*\*/g, "$1")
      // Underline
      .replace(/__(.*?)__/g, "$1")
      // Italic (must run after bold/underline, and after horizontal rules)
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
      // Unicode bullets that survive line-start stripping (e.g. inline
      // after newline collapse, or emitted by some LLMs as • instead of -).
      .replace(/•/g, "")
      // Remove stray backticks that may remain from malformed inline code fences.
      // Other markdown characters are handled by the explicit replacements above;
      // a bare backtick is the only common leftover that is clearly a formatting
      // marker rather than ordinary punctuation.
      .replace(/`/g, "")
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
 * The working length of one utterance, in characters.
 *
 * It was 60, and 60 was justified only by Piper's and Kokoro's ~510-phoneme
 * limit — not by the engine actually in use. The price of respecting it was a
 * boundary scan that cut sentences mid-clause, which is what the listener hears
 * as a stutter: at 60, the four-sentence reply measured six utterances with two
 * of them ending mid-sentence, and a request for 60 characters could come back
 * with 71.
 *
 * 120 is where whole sentences of both measured replies fit without a scan at
 * all. Above it the utterance stops being one — a reply divided at 240 comes
 * back as calls of 190 and 233 characters — and the mean silence over three
 * runs was lowest here on both measured replies, above it at 240, and higher
 * again unbounded. Lower brings the scan back.
 *
 * An engine that cannot synthesize 120 characters reports it and is retried on
 * smaller pieces, so this is a target rather than a hard ceiling on what any
 * engine may be handed.
 */
export const TTS_WORKING_LENGTH = 120;

/**
 * Split a reply into utterances safe for TTS engines.
 *
 * The division follows the sentence structure whenever the text has one: whole
 * sentences are packed into an utterance while they fit within `maxChars`, and
 * only a sentence longer than `maxChars` on its own goes to the boundary scan
 * below. Every streaming caller passes exactly one sentence, so for those this
 * is the scan and nothing else — no regrouping, and no waiting for a following
 * sentence before the first audio can start.
 *
 * Boundary preference inside an over-long sentence (strongest first):
 * 1. Vietnamese two-word phrase boundaries (e.g., "cụ thể")
 * 2. Colons and semicolons — natural clause boundaries
 * 3. Commas — phrase boundaries
 * 4. Vietnamese single phrase-start words (e.g., "cho", "với") — clause boundaries
 * 5. Spaces — word boundaries
 * 6. Hard split at maxChars — last resort
 *
 * The scan balances distance from the ideal maxChars against boundary
 * strength, so a boundary near the working length wins over a stronger one far
 * behind it. It still refuses to separate a number from its noun
 * ("cho 5" / "người lớn tuổi").
 *
 * @param text The text to split.
 * @param maxChars Maximum characters per utterance (default: TTS_WORKING_LENGTH).
 * @returns Array of chunks.
 */
export function splitForTTS(text: string, maxChars = TTS_WORKING_LENGTH): string[] {
  return joinUndersizedFragments(divideAtSentences(text, maxChars), maxChars);
}

/**
 * Divides text where its sentences divide, packing whole sentences into one
 * utterance while they fit within `maxChars`. A sentence longer than `maxChars`
 * on its own is divided by the boundary scan rather than packed with anything.
 *
 * Text that carries at most one sentence — which is everything the streaming
 * callers pass — is handed straight to the scan, so what those callers submit,
 * and when they submit it, is unchanged.
 */
function divideAtSentences(text: string, maxChars: number): string[] {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) {
    return splitOneSentence(text, maxChars);
  }

  const chunks: string[] = [];
  let packed = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (packed) {
        chunks.push(packed);
        packed = "";
      }
      chunks.push(...splitOneSentence(sentence, maxChars));
      continue;
    }

    const candidate = packed ? `${packed} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      packed = candidate;
    } else {
      if (packed) chunks.push(packed);
      packed = sentence;
    }
  }

  if (packed) chunks.push(packed);
  return chunks;
}

/** Divides one sentence — or a fragment with no sentence boundary in it — at
 * the best boundary the backward scan can find. */
function splitOneSentence(text: string, maxChars: number): string[] {
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

      // Only a two-word phrase pair may reach below the soft minimum. A comma
      // far back is not a licence to stop there: exempting punctuation is what
      // let an 11-character opener like "Trước tiên," become an utterance of
      // its own, because a comma scores 80 however distant it is.
      if (i < softMin && !isPhrasePair) continue;

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

      // Prefer boundaries close to the target length. Two points per character
      // back is enough that a space at the working length outranks a comma more
      // than 35 characters behind it, while a phrase pair (130) can still win
      // from 60 characters back. At the old 0.3 per character no distance was
      // ever far enough to lose.
      score -= Math.abs(i - maxChars) * 2;

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
 * Joins a fragment too short to be spoken on its own into a neighbouring
 * utterance — a stray "mèo?" left after dividing a long sentence, or an
 * introductory "Trước tiên," that would otherwise be heard alone.
 *
 * Every utterance is inspected, not only the last one: once a long sentence is
 * divided, a short fragment can land anywhere in the reply. A join never pushes
 * an utterance past `maxChars`; when neither neighbour leaves room, the
 * fragment stays separate. That bound is what the old 1.5x ceiling was working
 * around — a join that only ever looked backwards, and only ever once.
 */
function joinUndersizedFragments(chunks: string[], maxChars: number): string[] {
  const minWords = 3;
  const minChars = 15;
  const undersized = (chunk: string): boolean =>
    chunk.trim().split(/\s+/).length < minWords || chunk.length < minChars;

  const joined: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!undersized(chunk)) {
      joined.push(chunk);
      continue;
    }

    // Backwards first: the fragment reads as the tail of what precedes it.
    const prev = joined[joined.length - 1];
    if (prev !== undefined && prev.length + 1 + chunk.length <= maxChars) {
      joined[joined.length - 1] = `${prev} ${chunk}`;
      continue;
    }

    // Otherwise forward, which is how an opening phrase rejoins the clause it
    // introduces. `chunks[i + 1]` is unvisited, so it cannot be double-counted.
    const next = chunks[i + 1];
    if (next !== undefined && chunk.length + 1 + next.length <= maxChars) {
      joined.push(`${chunk} ${next}`);
      i++;
      continue;
    }

    joined.push(chunk);
  }

  return joined;
}

/**
 * Attempt to synthesize text, and recover from a failure by dividing it.
 *
 * Any failure is retried as smaller pieces. Whether dividing an utterance can
 * rescue it is not knowable before trying, and it is not a property of the
 * engine's error text — matching two Piper strings made recovery available to
 * one engine and withheld it from the others (D6). Only an abort is exempt,
 * because the caller asked for that and not for audio, and an utterance too
 * short to divide is reported as it failed.
 *
 * When both halves come back as WAV they are concatenated into one buffer, so no
 * audio is lost. If they cannot be concatenated the utterance fails whole: half
 * an utterance returned as though it were the whole of it is the silent
 * truncation this change removes, and a caller can report an absence at an
 * index but nothing can report a half.
 *
 * @param text The text to synthesize.
 * @param ttsOptions Engine, voice, and optional abort signal.
 * @param depth Recursion depth (max 3).
 * @param signal Optional abort signal; if aborted, recursion stops early.
 * @param synthesizeFn The synthesizer to call; injectable for tests.
 * @returns Audio buffer.
 * @throws If synthesis fails and cannot be recovered.
 */
export async function synthesizeSpeechWithFallback(
  text: string,
  ttsOptions: SynthesizeOptions,
  depth = 0,
  signal?: AbortSignal,
  synthesizeFn: (text: string, options: SynthesizeOptions) => Promise<Buffer> = synthesizeSpeech
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
    return await synthesizeFn(normalizedText, { ...ttsOptions, signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);

    if (normalizedText.length > 15) {
      console.warn(
        `[synthesizeSpeechWithFallback] Retrying split for chunk "${normalizedText.slice(0, 40)}..." (depth=${depth}): ${message}`
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
        let leftBuf: Buffer;
        let rightBuf: Buffer;
        try {
          leftBuf = await synthesizeSpeechWithFallback(
            left,
            ttsOptions,
            depth + 1,
            signal,
            synthesizeFn
          );
          if (signal?.aborted) {
            throw new DOMException("TTS synthesis aborted", "AbortError");
          }
          rightBuf = await synthesizeSpeechWithFallback(
            right,
            ttsOptions,
            depth + 1,
            signal,
            synthesizeFn
          );
        } catch (retryError) {
          if (retryError instanceof Error && retryError.name === "AbortError") {
            throw retryError;
          }
          // Dividing the utterance did not rescue it. Report the failure that
          // started this rather than whichever one the retry happened to end
          // in — unwrapped, a dead gateway surfaced as "max recursion depth",
          // which names the retry strategy instead of the cause (D6). The
          // retry's own error is kept as the cause.
          throw new Error(
            `TTS failed and dividing the utterance did not recover it ` +
              `("${normalizedText.slice(0, 40)}..."): ${message}`,
            { cause: retryError }
          );
        }

        // If both halves are WAV, concatenate so no audio is lost
        const isWav = (b: Buffer) =>
          b.length >= 4 && b.toString("ascii", 0, 4) === "RIFF";
        const leftWav = isWav(leftBuf);
        const rightWav = isWav(rightBuf);

        if (leftWav && rightWav) {
          return concatWavBuffers([leftBuf, rightBuf]);
        }

        // For non-WAV formats (e.g. MP3) the halves cannot be joined, and
        // returning the left one would speak half an utterance as though it were
        // all of it. Report the loss instead, so the caller can report it too.
        throw new Error(
          `Recovered halves cannot be joined (left=${leftWav ? "wav" : "not wav"}, ` +
            `right=${rightWav ? "wav" : "not wav"}); refusing to return half of ` +
            `"${normalizedText.slice(0, 40)}..."`
        );
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

  const savedUrls: string[] = [];

  const cleanupOnAbort = async () => {
    if (savedUrls.length > 0) {
      await Promise.all(savedUrls.map((url) => deleteAudio(url).catch(() => undefined)));
      savedUrls.length = 0;
    }
  };

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
    savedUrls.push(urlPath);

    if (signal?.aborted) {
      await cleanupOnAbort();
      return [];
    }

    return [{ urlPath, text: chunk }];
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      await cleanupOnAbort();
      return [];
    }

    const msg = err instanceof Error ? err.message : String(err);

    // Same rule as `synthesizeSpeechWithFallback` (D6): any failure is worth one
    // attempt at dividing, whichever engine it came from. This twin kept the
    // Piper-only classifier, which would have withheld that attempt from the
    // other engines the moment anything called it.
    if (normalizedChunk.length > 15) {
      console.warn(
        `[synthesizeChunkWithFallback] Retrying split for chunk "${normalizedChunk.slice(0, 40)}..." (depth=${depth}): ${msg}`
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

        // Track URLs returned by recursive calls so we can clean them up on abort.
        for (const result of leftResults) {
          if (result.urlPath) savedUrls.push(result.urlPath);
        }

        if (signal?.aborted) {
          await cleanupOnAbort();
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

  // The whole reply is in hand before anything is synthesized — this function
  // returns one concatenated buffer and no caller sees a chunk before the last
  // — so the division is handed the whole of it and packs whole sentences into
  // one call each (design.md D1). Packing costs nothing here, which is not true
  // of the streaming routes: those hand over one sentence per call and are left
  // alone, because making them wait for a following sentence would delay the
  // first audio of every turn.
  //
  // Text carrying no letter at all was already rejected above, and the division
  // never comes back empty for text that carries one, so there is nothing left
  // to guard against here. A sentence that carried no letter used to be dropped
  // before being chunked; now it is spoken as part of the utterance around it,
  // which is what it is.
  const chunks = splitForTTS(normalizedText);

  const buffers: Buffer[] = [];
  const concurrency = 3;
  for (let i = 0; i < chunks.length; i += concurrency) {
    if (signal?.aborted) {
      throw new DOMException("TTS synthesis aborted", "AbortError");
    }

    const batch = chunks.slice(i, i + concurrency);
    const batchBuffers = await Promise.all(
      batch.map(async (chunk) => {
        if (signal?.aborted) {
          throw new DOMException("TTS synthesis aborted", "AbortError");
        }
        const normalizedChunk = normalizeTextForEngine(chunk, engine);
        if (!hasSynthesizableContent(normalizedChunk)) {
          return null;
        }
        return synthesizeFn(chunk, options, 0, signal);
      })
    );

    for (const buffer of batchBuffers) {
      if (buffer) buffers.push(buffer);
    }
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

    if (signal?.aborted) {
      await deleteAudio(urlPath).catch(() => undefined);
      throw new DOMException("TTS synthesis aborted", "AbortError");
    }

    return { buffer: combinedBuffer, urlPath, text: normalizedText };
  }

  return { buffer: combinedBuffer, text: normalizedText };
}

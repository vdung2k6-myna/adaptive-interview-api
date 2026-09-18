/**
 * Stateful sentence extraction from a streaming LLM token stream.
 *
 * Feeds raw tokens, accumulates them, and emits newly-completed sentences
 * in real time. Handles markdown stripping, code-fence guards, and
 * trailing-text salvage after the stream ends.
 */

import { splitSentences } from "./split-sentences";
import { splitForTTS, stripMarkdown } from "./text-processing";

export interface SentenceExtractorOptions {
  /**
   * Optional guard called on the *raw* accumulated text before sentence
   * splitting. Return true to skip extraction for this token.
   */
  shouldSkip?: (accumulatedRaw: string) => boolean;
}

export interface ExtractedSentence {
  /** The sentence as returned by splitSentences (may include trailing space). */
  raw: string;
  /** Trimmed text validated to contain at least one letter. */
  clean: string;
  /** TTS-safe chunks via splitForTTS. */
  chunks: string[];
}

export class SentenceExtractor {
  private accumulated = "";
  private emittedCount = 0;

  constructor(private options: SentenceExtractorOptions = {}) {}

  /** Feed a new token. Returns newly-completed sentences (ending with a delimiter). */
  feed(token: string): ExtractedSentence[] {
    this.accumulated += token;

    if (this.options.shouldSkip?.(this.accumulated)) {
      return [];
    }

    const prepared = stripMarkdown(this.accumulated);
    const all = splitSentences(prepared);

    const results: ExtractedSentence[] = [];

    for (let i = this.emittedCount; i < all.length; i++) {
      const raw = all[i];

      // A sentence without a trailing delimiter is still incomplete —
      // the LLM hasn't finished emitting it yet.
      if (!/[.!?…。？！]$/.test(raw)) {
        break;
      }

      const clean = raw.trim().replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "");

      // Skip pure punctuation / whitespace / number fragments.
      // TTS engines need real words; synthesizing "42." wastes time and
      // can trigger phoneme overflow errors.
      if (!clean || !/\p{L}/u.test(clean)) {
        this.emittedCount++;
        continue;
      }

      const chunks = splitForTTS(clean);
      results.push({ raw, clean, chunks });
      this.emittedCount++;
    }

    return results;
  }

  /**
   * After the LLM stream ends, extract any remaining sentences that
   * weren't emitted during streaming (because they lacked a trailing
   * delimiter while tokens were still arriving).
   *
   * If `fullText` is provided, it replaces the internal accumulated buffer.
   * This matters when cloud models stream empty tokens but return the full
   * text via a non-streaming fallback.
   */
  finalize(fullText?: string): ExtractedSentence[] {
    const text = fullText ?? this.accumulated;
    const prepared = stripMarkdown(text);
    const all = splitSentences(prepared);

    const results: ExtractedSentence[] = [];

    for (let i = this.emittedCount; i < all.length; i++) {
      const raw = all[i];
      const clean = raw.trim().replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "");

      if (!clean || !/\p{L}/u.test(clean)) {
        continue;
      }

      const chunks = splitForTTS(clean);
      results.push({ raw, clean, chunks });
    }

    // ── Trailing fragment salvage ──────────────────────────────────────
    // If the LLM ends mid-sentence (e.g., "Also, do you know" with no
    // closing punctuation), splitSentences will not return it as a sentence.
    // We salvage whatever text remains after the last delimiter so the user
    // hears it rather than it being silently dropped.
    const lastDelimiterMatch = [...prepared.matchAll(/[.!?…。？！]+/g)].pop();
    const tailStart = lastDelimiterMatch
      ? lastDelimiterMatch.index! + lastDelimiterMatch[0].length
      : 0;
    const tail = prepared.slice(tailStart).trim();
    const cleanTail = tail.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "");

    if (
      cleanTail &&
      /\p{L}/u.test(cleanTail) &&
      !results.some((r) => r.clean === cleanTail)
    ) {
      // Avoid duplicate if tail was already captured as a standalone sentence
      const chunks = splitForTTS(cleanTail);
      results.push({ raw: tail, clean: cleanTail, chunks });
    }

    return results;
  }

  /** Raw accumulated text so far. Useful for fallback when getFullText() is empty. */
  getAccumulated(): string {
    return this.accumulated;
  }
}

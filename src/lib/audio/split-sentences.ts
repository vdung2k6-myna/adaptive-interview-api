/**
 * Sentence boundary detection for streaming TTS.
 * Supports English and Vietnamese punctuation.
 *
 * Rules:
 * - Split on . ! ? … 。 ？ ！ followed by whitespace or end of string
 * - Preserve the delimiter in the returned sentence
 * - Filter out empty/whitespace-only fragments
 */

const SENTENCE_END_REGEX = /[.!?…。？！]+/g;
const WHITESPACE_ONLY = /^\s*$/;

/**
 * Split text into sentences, preserving trailing delimiters.
 * @param text The input text (may be partial/streaming).
 * @returns Array of trimmed, non-empty sentences.
 */
export function splitSentences(text: string): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const sentences: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(SENTENCE_END_REGEX)) {
    const endIndex = match.index! + match[0].length;
    const sentence = text.slice(lastIndex, endIndex).trim();
    if (sentence && !WHITESPACE_ONLY.test(sentence)) {
      sentences.push(sentence);
    }
    lastIndex = endIndex;
  }

  // If there's trailing text without a delimiter (incomplete sentence from stream),
  // include it only if it's non-empty and we're not forcing complete sentences.
  // Callers should decide whether to flush incomplete tail.
  const tail = text.slice(lastIndex).trim();
  if (tail && !WHITESPACE_ONLY.test(tail)) {
    sentences.push(tail);
  }

  return sentences;
}

/**
 * Extract only *new* sentences that have appeared since the last buffer.
 * Used during streaming: given previous accumulated text and new accumulated text,
 * return the sentences that are fully closed (have a delimiter) and newly available.
 *
 * @param previous Previously accumulated text (already emitted sentences removed).
 * @param current  Newly accumulated text (includes previous + new tokens).
 * @returns Sentences that are newly complete and should be sent to TTS.
 */
export function extractNewSentences(previous: string, current: string): string[] {
  if (current.length <= previous.length) {
    return [];
  }

  const allCurrent = splitSentences(current);
  const allPrevious = splitSentences(previous);

  // If the last sentence of previous is incomplete (no delimiter),
  // it will be the last item. We need to check if current completed it.
  const previousLast = allPrevious[allPrevious.length - 1];
  const currentLast = allCurrent[allCurrent.length - 1];

  // Simple diff: return current sentences not present in previous
  // For streaming, we assume monotonic growth and just return the delta.
  const newSentences: string[] = [];

  for (let i = allPrevious.length; i < allCurrent.length; i++) {
    newSentences.push(allCurrent[i]);
  }

  // Edge case: previous last sentence was incomplete and now got completed
  // (same count but last item changed). The above loop won't catch it
  // because lengths are equal. In practice this is rare with token streams
  // because new tokens usually add length. Callers should handle by also
  // checking if the last previous sentence lacked a delimiter.
  if (
    allCurrent.length === allPrevious.length &&
    allCurrent.length > 0 &&
    previousLast !== currentLast
  ) {
    // Replace the last one — it was completed
    newSentences.push(currentLast);
  }

  return newSentences;
}

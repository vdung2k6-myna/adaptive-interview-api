import { randomUUID } from "node:crypto";
import type {
  KnowledgeChunk,
  KnowledgeSearch,
  KnowledgeSearchOutcome,
  SearchOptions,
} from "@/lib/knowledge";

export const DEFAULT_PREFETCH_TOP_K = 3;

interface HeldPrefetch {
  /** The input this was issued for. A claim must match it exactly (D2). */
  input: string;
  /** The scope it was issued under, kept for diagnostics and parity with 4.6. */
  collections: string[];
  chunks: KnowledgeChunk[];
}

export interface PrefetchStore {
  /**
   * Run the scoped search for an input that has not been submitted yet, and hold
   * the result under a single-use id.
   *
   * Returns an id for an `ok: true` outcome — an empty `chunks` included, which
   * is an answer rather than a failure (D5) — and `null` for any failure, holding
   * nothing. A failure is never identified, because an `{ ok: false }` held here
   * would be the one route by which a refusal is served later as a retrieval
   * (D9).
   *
   * `options` is the search's, forwarded unchanged: a hold issued for a
   * material-reply persona is asked to carry the section its turn will speak,
   * and one issued for the generating path asks for nothing extra. The hold
   * itself stores no options — the section rides on the chunks (design.md D2, D6).
   */
  issue(input: string, collections?: string[], options?: SearchOptions): Promise<string | null>;

  /**
   * Take the held chunks for `id` when `submittedInput` is exactly the input it
   * was issued for.
   *
   * Single-use regardless of the answer: a claim of an unknown id returns null,
   * and a claim whose input differs discards the hold and returns null so the
   * caller searches fresh (D2, 3.4). Nothing is returned twice.
   */
  claim(id: string, submittedInput: string): KnowledgeChunk[] | null;

  /** Holds currently retained. For tests and diagnostics. */
  size(): number;
}

/**
 * The turn-scoped prefetch hold.
 *
 * Holds are in-process and unbounded by construction here, which is enough
 * because two rules already bound them: the client keeps at most one prefetch in
 * flight and aborts the previous (D6), and a claim consumes the hold whatever it
 * returns. What is *not* bounded is a hold whose turn is never submitted — a user
 * who types, prefetches, and navigates away leaves it retained until the process
 * exits. The design does not ask for an expiry, so none is invented here; if the
 * holds ever need one, this is the place it belongs.
 */
export function createPrefetchStore(options: {
  search: KnowledgeSearch;
  topK?: number;
}): PrefetchStore {
  const { search, topK = DEFAULT_PREFETCH_TOP_K } = options;
  const holds = new Map<string, HeldPrefetch>();

  return {
    async issue(input, collections = [], options) {
      const outcome: KnowledgeSearchOutcome = await search(input, topK, collections, options);
      if (!outcome.ok) {
        return null;
      }

      const id = randomUUID();
      holds.set(id, { input, collections, chunks: outcome.chunks });
      return id;
    },

    claim(id, submittedInput) {
      const hold = holds.get(id);
      if (!hold) return null;

      holds.delete(id);
      if (hold.input !== submittedInput) return null;

      return hold.chunks;
    },

    size() {
      return holds.size;
    },
  };
}

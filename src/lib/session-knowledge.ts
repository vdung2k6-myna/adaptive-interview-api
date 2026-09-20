import type { KnowledgeChunk, KnowledgeSearch } from "@/lib/knowledge";

export const DEFAULT_SESSION_TOP_K = 3;

interface HeldSearch {
  /** The scope this search was issued for. Its chunks are served only for it (4.6). */
  collections: string[];
  /**
   * The chunks, once the search has answered — empty until then, and empty after
   * a search that did not yield a result. Both read as "nothing to fall back
   * on", which 4.4 expects rather than treats as an error.
   */
  chunks: KnowledgeChunk[];
}

export interface SessionKnowledge {
  /**
   * Issue the session's topic-scoped search for a scope, unless one is already
   * held for it. Returns whether this call issued one, so a caller can log what
   * it actually did rather than what it asked for.
   */
  ensure(collections: string[], query: string): boolean;

  /**
   * The held chunks, but only for a turn whose resolved collections are those
   * they were issued for. Empty for any other scope, and empty while nothing is
   * held.
   */
  chunksFor(collections: string[]): KnowledgeChunk[];

  /** Chunks currently held. For tests and diagnostics. */
  size(): number;
}

/**
 * The session's topic-scoped fallback search (design.md D4).
 *
 * A voice turn's text does not exist until transcription returns, so the search
 * that covers a turn whose own search *fails* cannot be the turn's own: it has to
 * be issued early, speculatively, and its whole job is to be there if a later
 * search comes back empty-handed. It is therefore issued on the session's first
 * turn carrying topics, concurrently with that turn's transcription, and is never
 * awaited — a speculative search that hangs must not be able to delay a turn.
 *
 * Three properties live here, because 4.1, 4.2 and 4.6 assert them:
 *
 * - **at most one per scope.** Nothing on the wire identifies a session — no
 *   request carries a session id, and a session's first turn is the one whose
 *   `history` is empty — so the hold is keyed by the scope it was issued for and
 *   is replaced when a new session opens on a different scope. Two *concurrent*
 *   sessions in one process therefore share this hold; with no session id to key
 *   by, that is inherent rather than overlooked, and it can only ever reduce the
 *   number of searches issued, never serve a scope a turn did not ask for;
 * - **never awaited.** `ensure` starts the search and returns;
 * - **served by scope.** Chunks are handed out only for the collections they were
 *   issued for, so a turn that enabled different topics mid-session gets nothing
 *   rather than another session's topics (4.6).
 *
 * A `!ok` outcome is held as no chunks rather than as a reason. The fallback's
 * only question is whether it has anything to offer, and a search that failed to
 * obtain a result has nothing — including a refusal, which D9 forbids serving as
 * knowledge at the layer that saw it.
 */
export function createSessionKnowledge(options: {
  search: KnowledgeSearch;
  topK?: number;
}): SessionKnowledge {
  const { search, topK = DEFAULT_SESSION_TOP_K } = options;
  let hold: HeldSearch | null = null;

  return {
    ensure(collections, query) {
      if (!collections.length) return false;
      // doc-etl-api answers a whitespace-only query with a rejection, so one is
      // never sent. The route cannot produce one while it only ensures for a
      // non-empty scope; this is where that stops being the route's promise.
      if (!query.trim()) return false;
      if (hold && sameScope(hold.collections, collections)) return false;

      const entry: HeldSearch = { collections: [...collections], chunks: [] };
      hold = entry;

      // Deliberately neither awaited nor returned. An outcome is a value rather
      // than a rejection (knowledge.ts), so nothing here can surface as an
      // unhandled rejection and end the process.
      void search(query, topK, entry.collections).then((outcome) => {
        if (outcome.ok) entry.chunks = outcome.chunks;
      });

      return true;
    },

    chunksFor(collections) {
      if (!hold || !sameScope(hold.collections, collections)) return [];
      return hold.chunks;
    },

    size() {
      return hold?.chunks.length ?? 0;
    },
  };
}

/**
 * Whether two resolved scopes are the same scope. Order- and duplicate-insensitive,
 * because `resolveCollections` already dedupes: a difference here is a different
 * *set* of topics, and re-ordering the same topics is not a different scope.
 */
function sameScope(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a]
    .sort()
    .every((name, i) => name === sorted[i]);
}

/**
 * Topic labels to doc-etl-api collection names.
 *
 * The labels live in the persona (the client's `personas.ts`), the collection
 * names live in the corpus. This module is the one place they are related, and
 * it relates them by convention rather than by a table: a table would be a third
 * copy of both, and a drift between copies fails silently as an empty result
 * rather than as an error (design.md D8).
 */

/** doc-etl-api's `COLLECTION_NAME_PATTERN` (`config.py`); outside it is a 400. */
export const COLLECTION_NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Longest name doc-etl-api accepts (`MAX_COLLECTION_NAME_LENGTH`). */
export const MAX_COLLECTION_NAME_LENGTH = 64;

/**
 * Fold a persona topic label to a collection name: lowercase, Vietnamese
 * diacritics stripped, each run of characters outside `a-z0-9` replaced by a
 * single hyphen, leading and trailing hyphens removed.
 *
 * `đ` is folded explicitly because it is a letter rather than a composed
 * diacritic — NFD does not decompose it, so the mark-stripping pass below would
 * otherwise leave it to become a hyphen and turn `Đường` into `-uong`.
 */
export function foldTopicLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface TopicResolution {
  /** Names to scope the search to. Empty when nothing survived. */
  collections: string[];
  /** Labels that folded to nothing, for the caller to log. */
  dropped: string[];
}

/**
 * Resolve enabled topic labels to the collection names that scope a search.
 *
 * Two rules, both there to keep a malformed filter unreachable rather than
 * merely unlikely, because doc-etl-api answers an empty filter with a 400 that
 * loses the whole search (D8):
 *
 * - a label folding to an empty name is dropped, not sent;
 * - duplicates are collapsed, so the same scope always produces the same list.
 *
 * The result may still be empty, which means *issue no search at all* — never an
 * unscoped one. Deciding that is the caller's, not this function's.
 *
 * Dropped labels are returned rather than logged here so this stays pure; the
 * caller logs them.
 */
export function resolveCollections(labels: string[]): TopicResolution {
  const collections: string[] = [];
  const dropped: string[] = [];

  for (const label of labels) {
    const name = foldTopicLabel(label);
    if (!name) {
      dropped.push(label);
      continue;
    }
    if (!collections.includes(name)) {
      collections.push(name);
    }
  }

  return { collections, dropped };
}

export interface UnservedTopic {
  label: string;
  /** The collection name this label folds to, which nothing in the catalog serves. */
  collection: string;
}

/**
 * The enabled labels whose folded name no source in the catalog serves.
 *
 * This is the assertion that a persona's topic and the corpus agree, and the one
 * that catches the fold's spelling disagreeing with an operator's hand-tagging —
 * `c-12` against a corpus tagged `csharp-12`, say, which D8 keeps a table
 * available to override. Either way the failure is a label whose results would
 * silently be empty for every turn, so it belongs at build time rather than in an
 * answer.
 *
 * It takes the catalog as an argument on purpose: `GET /sources` on doc-etl-api
 * reports each source's collections, and the union of those is the catalog, so
 * the same check runs against a fixture in the suite or against the live service.
 * A label folding to no name at all is skipped — dropping those is 2.3's rule,
 * and the empty name is not a claim about the catalog.
 */
export function findUnservedTopics(
  labels: string[],
  catalogCollections: string[]
): UnservedTopic[] {
  const served = new Set(catalogCollections);
  const unserved: UnservedTopic[] = [];

  for (const label of labels) {
    const collection = foldTopicLabel(label);
    if (!collection) continue;
    if (!served.has(collection)) {
      unserved.push({ label, collection });
    }
  }

  return unserved;
}

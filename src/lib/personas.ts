/**
 * The persona catalog's read model.
 *
 * A *row* is what the table stores; a *catalog entry* is what the route reports.
 * The two differ in ways worth naming: the entry carries no timestamps and no
 * sort order, and its answer mode is always one of two values even when the
 * row's column is null or holds something else.
 */

/** The mode a persona without one is stored as, and the mode every reply falls
 * back to. Named because three places rely on it agreeing: the column default,
 * the seed, and the read below. */
export const DEFAULT_ANSWER_MODE = "generate";

/** How a persona's replies are produced: by the model, or by reading the
 * material its topics scope. */
export type AnswerMode = "generate" | "material";

/** What the catalog reports for one persona. */
export interface CatalogEntry {
  id: string;
  label: string;
  emoji: string;
  defaultPrompt: string;
  knowledgeTopics: string[];
  answerMode: AnswerMode;
}

/**
 * A persona as stored.
 *
 * `answerMode` is nullable because the row is read from a database this module
 * does not own: a persona written before answer modes existed, or by something
 * that bypassed the column's default, arrives as null rather than as
 * `"generate"`, and the catalog's contract is that it reports a mode anyway.
 */
export interface PersonaRow {
  id: string;
  label: string;
  emoji: string;
  defaultPrompt: string;
  knowledgeTopics: string[];
  answerMode: string | null;
  sortOrder: number;
}

/**
 * Fold a stored or submitted answer mode to the one this platform acts on.
 *
 * Only the material mode is anything other than generating. That is not a
 * fallback for a malformed value so much as the true answer for one: the gate
 * reads material only when a persona asks for it by name, so a row stored with
 * no mode, an empty mode or a misspelling of `material` generates every reply it
 * will ever produce. Reporting the stored string verbatim would tell the client
 * a persona's replies come from a mode that does not exist.
 *
 * One function rather than two, because two would be two chances to disagree:
 * the catalog folds a row, and the turn folds the same value arriving as a
 * request field.
 */
export function resolveAnswerMode(raw: unknown): AnswerMode {
  return raw === "material" ? "material" : DEFAULT_ANSWER_MODE;
}

/** One row as the catalog reports it. */
export function toCatalogEntry(row: PersonaRow): CatalogEntry {
  return {
    id: row.id,
    label: row.label,
    emoji: row.emoji,
    defaultPrompt: row.defaultPrompt,
    knowledgeTopics: row.knowledgeTopics,
    answerMode: resolveAnswerMode(row.answerMode),
  };
}

/**
 * The whole catalog, in the order it is meant to be read.
 *
 * Sorted here rather than only in the query, because the order is a property of
 * the catalog and not of one call to it — a read that took the rows as the
 * database happened to hand them back would render differently between
 * requests, and this is the only place the order can be asserted without a
 * database.
 *
 * The seed leaves gaps of ten, so two personas sharing a `sortOrder` means
 * someone wrote them to the same position. The identifier breaks the tie so the
 * order stays total, and a copy is sorted rather than the caller's array.
 */
export function toCatalog(rows: PersonaRow[]): CatalogEntry[] {
  return [...rows]
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toCatalogEntry);
}

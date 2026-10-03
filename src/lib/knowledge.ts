import config from "@/lib/config";

/**
 * A chunk of knowledge as this backend consumes it.
 *
 * The last three fields are the routing metadata `doc-etl-api`'s `/search`
 * began reporting alongside the text: they let a hit locate its own source
 * rather than only quote it. They are optional because a service older than
 * that change omits them, and their absence is a fact the caller has to be able
 * to see — it is what tells the material path it cannot gate or read this hit
 * and must generate instead (design.md D6, D3).
 *
 * `score` is optional for the same reason: an unranked chunk is not a confident
 * one, and there is no number that says so.
 */
/**
 * A hit's section, as the search reports it: the source's own text over the run
 * of stored chunks the hit belongs to, with the range it was taken from.
 *
 * The text is a passage of the document rather than the stored chunks joined, so
 * a heading every chunk of the run repeats appears in it once, and text the
 * chunker dropped between them is not missing from it.
 */
export interface KnowledgeSection {
  /** The source's own characters over the section's run of chunks. */
  text: string;
  /** Where `text` begins in the source's document, counted in characters. */
  start: number;
  /** Where it ends, exclusive: the document sliced at `[start, end)` is `text`. */
  end: number;
  /**
   * How long the whole section is, in characters — so `end - start` smaller than
   * this is a bounded expansion's fragment rather than the whole passage.
   */
  size: number;
}

export interface KnowledgeChunk {
  text: string;
  source: string;
  score?: number;
  /**
   * The name the index stores this chunk's source under, and the value that
   * source's content is fetched by. For a file it is the filename; for a URL it
   * is the final URL after redirects, which differs from `source` when the
   * submitted URL redirected.
   */
  address?: string;
  /** The collections this chunk's source belongs to — the gate's input. An
   * empty array means the source is in none, which is not the same fact as a
   * service that reported no collections at all. */
  collections?: string[];
  /**
   * This chunk's zero-based position in its source, in reading order.
   *
   * Absent and `0` are different: a service that omits it cannot be read from.
   * Compare it against a chunk's position only after testing it for a number —
   * `undefined === undefined` is true, so an unguarded `find` over content
   * whose chunks also lack a position would match the first one.
   */
  position?: number;
  /**
   * This hit's section, when the search was asked to expand to one: the source's
   * own text for the run of chunks the hit belongs to, with the range it came
   * from and the passage's true length.
   *
   * Absent is not empty: absent means the search asked for no section, the
   * service predates the expansion, or the hit's source holds no section to
   * return — each a fact the material gate has to be able to see, so it generates
   * rather than speaking nothing. A present section whose `text` is empty is the
   * different fact that the run holds no words, which the reply refuses rather
   * than the gate.
   */
  section?: KnowledgeSection;
}

/**
 * The subset of doc-etl-api's `SearchResult` (`doc_etl_api/schemas.py`) that
 * this client reads. The server also returns `source_id`, `source_type`,
 * `neighbours_before`, `neighbours_after` and `neighbours` — declare a field
 * here only when something consumes it, so this interface cannot drift into
 * describing fields the server does not actually send.
 */
interface DocEtlSearchResult {
  text?: string;
  source_name?: string;
  score?: number;
  address?: string;
  collections?: string[];
  position?: number;
  section?: DocEtlSection | null;
}

/**
 * `SectionExpansion` on the service side (`doc_etl_api/schemas.py`), as this
 * client reads it.
 *
 * Every field is optional here and checked rather than defaulted: a section
 * missing one of its numbers cannot say where its text came from or how long the
 * whole passage is, which are the facts eligibility is decided on. `readSection`
 * reads such an object as absent rather than filling in a guess — a section that
 * cannot state its own completeness is refused by the gate.
 */
interface DocEtlSection {
  text?: string;
  start?: number;
  end?: number;
  size?: number;
}

interface DocEtlSearchResponse {
  results?: DocEtlSearchResult[];
}

const DEFAULT_TOP_K = 3;

/** Statuses doc-etl-api uses to report that *our* request was malformed. */
const REFUSAL_STATUSES = new Set([400, 422]);

/**
 * Why a search did not produce a result.
 *
 * `"rejected"` is split out because it is not the service failing to answer — it
 * is the service refusing a request this backend built. Answering it with the
 * session's fallback chunks would render our own defect as a slightly-off
 * success, which is the unreadable state D5 refuses (design.md D9).
 */
export type KnowledgeFailureReason =
  | "timeout" // our own timeout fired at config.docEtl.searchTimeoutMs
  | "unreachable" // fetch threw: DNS, refused connection, no network
  | "server_error" // the service answered, but not with a search result
  | "rejected"; // the service understood the request and refused it

/**
 * A search's outcome.
 *
 * A value rather than a thrown error on purpose: the topic-scoped search is
 * issued without being awaited, and under Node's default
 * `--unhandled-rejections=throw` a rejection with no handler ends the process —
 * which would turn a doc-etl-api fault into a dead server instead of the
 * degraded turn D5 asks for. A value cannot reject (design.md D9).
 */
export type KnowledgeSearchOutcome =
  | { ok: true; chunks: KnowledgeChunk[] }
  | { ok: false; reason: KnowledgeFailureReason };

/**
 * The shape of a search, for collaborators that take one as a parameter rather
 * than importing this module's function directly (design.md D10).
 */
export type KnowledgeSearch = typeof searchKnowledge;

/** doc-etl-api's own message for a refusal, when it sent one this can read. */
async function readServiceDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    // FastAPI's own 422 carries an array of error objects.
    if (Array.isArray(body.detail)) return JSON.stringify(body.detail);
    return "";
  } catch {
    return "";
  }
}

/**
 * A hit's section as this client reads it, or `undefined` when the service sent
 * none this can read.
 *
 * A section is read whole or not at all: its numbers are what say where the text
 * came from and how long the whole passage is, and a section that cannot state
 * them cannot be known to be complete, so it is read as absent rather than
 * guessed at. A text that is empty is a section this can read, and one that holds
 * no words — a fact the reply refuses separately, because it says something other
 * than "this hit has no section".
 */
function readSection(raw: DocEtlSection | null | undefined): KnowledgeSection | undefined {
  // An absent section is the ordinary answer for a search that asked for none,
  // and `null` is the service saying a source holds no range to place a run by.
  // Neither is drift, so neither warns.
  if (raw === null || raw === undefined) return undefined;

  // A section that arrived as something other than an object is the response
  // shape of a service older than this client — the one it read sections as a
  // list from — so it is worth saying out loud rather than degrading in silence.
  if (typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(
      "[Knowledge] doc-etl-api sent a `section` that is not an object — the " +
        "/search contract may have changed"
    );
    return undefined;
  }

  const { text, start, end, size } = raw;
  if (
    typeof text !== "string" ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    typeof size !== "number"
  ) {
    console.warn(
      "[Knowledge] doc-etl-api sent a `section` missing its text or its " +
        "range — the /search contract may have changed"
    );
    return undefined;
  }

  return { text, start, end, size };
}

/**
 * The search options a caller may state beside the query and its scope.
 *
 * `expand` asks the service for each result's whole section alongside the ranked
 * chunks, which is what lets a material turn read its reply from the hit rather
 * than fetch the source again (design.md D5).
 */
export interface SearchOptions {
  expand?: "section";
}

/**
 * Search the document ETL service for relevant knowledge chunks.
 *
 * Never throws and never rejects: every way of failing to obtain a result is
 * reported as `{ ok: false, reason }`, so the voice-agent stream never breaks
 * *and* its callers can branch on why. `{ ok: true, chunks: [] }` is an answer —
 * in scope, nothing relevant — and is not a failure (design.md D5, D9).
 *
 * `collections` scopes the search. It is sent only when non-empty: doc-etl-api
 * answers an empty filter with a 400 that loses the whole search, so omitting
 * the field entirely is what keeps an unscoped-but-valid search reachable and an
 * empty filter unreachable (design.md D8).
 *
 * `options.expand` is likewise sent only when stated. A turn that generates its
 * reply must issue the request it has always issued — the service rejects an
 * unknown field outright, and a speculative prefetch should not pay for a
 * passage nothing will read.
 */
export async function searchKnowledge(
  query: string,
  topK: number = DEFAULT_TOP_K,
  collections?: string[],
  options?: SearchOptions
): Promise<KnowledgeSearchOutcome> {
  const url = `${config.docEtl.apiUrl}/search`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), config.docEtl.searchTimeoutMs);

  const requestBody: {
    query: string;
    top_k: number;
    collections?: string[];
    expand?: "section";
  } = {
    query,
    top_k: topK,
  };
  if (collections?.length) {
    requestBody.collections = collections;
  }
  if (options?.expand) {
    requestBody.expand = options.expand;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (REFUSAL_STATUSES.has(response.status)) {
        const detail = await readServiceDetail(response);
        console.warn(
          `[Knowledge] doc-etl-api refused the search (${response.status} ` +
            `${response.statusText})${detail ? `: ${detail}` : ""} — a defect in the ` +
            "request this backend built, not a service outage, so the session's " +
            "fallback chunks are not used for this turn"
        );
        return { ok: false, reason: "rejected" };
      }

      console.warn(
        `[Knowledge] doc-etl-api returned ${response.status} ${response.statusText}`
      );
      return { ok: false, reason: "server_error" };
    }

    let data: DocEtlSearchResponse;
    try {
      data = (await response.json()) as DocEtlSearchResponse;
    } catch (err) {
      console.warn(
        "[Knowledge] doc-etl-api answered with a body that is not JSON:",
        err instanceof Error ? err.message : err
      );
      return { ok: false, reason: "server_error" };
    }

    if (data.results !== undefined && !Array.isArray(data.results)) {
      console.warn(
        "[Knowledge] doc-etl-api answered with a non-array `results` — the " +
          "/search contract may have changed"
      );
      return { ok: false, reason: "server_error" };
    }

    const results = data.results ?? [];

    // Every doc-etl-api ingestion path sets `source_name`, including the startup
    // bootstrap, so a missing one means the /search contract has drifted. Warn
    // rather than substituting a value: a placeholder renders as legitimate
    // attribution and makes the drift look like real data.
    const unattributed = results.filter((r) => !r.source_name).length;
    if (unattributed) {
      console.warn(
        `[Knowledge] ${unattributed}/${results.length} chunk(s) had no source_name — ` +
          "the doc-etl-api /search contract may have changed"
      );
    }

    return {
      ok: true,
      chunks: results.map((r) => ({
        text: r.text ?? "",
        source: r.source_name ?? "",
        score: r.score,
        address: r.address,
        collections: r.collections,
        position: r.position,
        section: readSection(r.section),
      })),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.warn(
      `[Knowledge] doc-etl-api ${isTimeout ? "timed out" : "unreachable"}:`,
      err instanceof Error ? err.message : err
    );
    return { ok: false, reason: isTimeout ? "timeout" : "unreachable" };
  }
}

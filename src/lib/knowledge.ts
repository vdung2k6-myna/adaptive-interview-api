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
/** One chunk of a hit's section, as the search reports it. */
export interface KnowledgeSectionChunk {
  text: string;
  /** Zero-based position in the hit's source, in reading order. */
  position: number;
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
   * The chunks of this hit's own section, in reading order, when the search was
   * asked to expand to one. This hit's own text is among them, repeated rather
   * than referenced, so the passage can be spoken from these chunks alone.
   *
   * Absent is not empty: absent means the search asked for no section, or the
   * service predates the expansion. Both are facts the material gate has to be
   * able to see, so it generates rather than speaking nothing.
   */
  section?: KnowledgeSectionChunk[];
  /**
   * How many chunks this hit's section really holds, whether or not every one of
   * them came back with the search — which is what tells a bounded expansion's
   * fragment from a complete section.
   *
   * Zero is what the service sends both when no section was asked for and when
   * the hit's place in its source could not be established, so a zero is never
   * on its own a statement that a section exists.
   */
  sectionSize?: number;
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
  section?: DocEtlSectionChunk[];
  section_size?: number;
}

/**
 * `NeighbourChunk` on the service side, as this client reads it.
 *
 * The server declares `position` as required here — unlike the top-level
 * `SearchResult`, where it only began appearing when the routing metadata did —
 * so a section entry that carries none is a malformed response rather than an
 * older service. `readSection` drops one rather than guessing where its text
 * belongs in the passage.
 */
interface DocEtlSectionChunk {
  text?: string;
  position?: number;
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
 * none.
 *
 * An entry whose position is not a number is dropped rather than ordered on a
 * guess: the section is joined in reading order, and an entry with no position
 * cannot say where its text belongs. Dropping one leaves the section shorter
 * than the size the service reported, which is the same fact a bounded
 * expansion produces — so a malformed entry refuses the reply rather than
 * speaking a passage in the wrong order.
 */
function readSection(raw: DocEtlSectionChunk[] | undefined): KnowledgeSectionChunk[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const section: KnowledgeSectionChunk[] = [];
  for (const entry of raw) {
    if (typeof entry.position !== "number") continue;
    section.push({ text: entry.text ?? "", position: entry.position });
  }
  return section;
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
        sectionSize: r.section_size,
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

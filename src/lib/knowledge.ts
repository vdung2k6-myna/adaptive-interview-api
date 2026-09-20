import config from "@/lib/config";

export interface KnowledgeChunk {
  text: string;
  source: string;
  score?: number;
}

/**
 * The subset of doc-etl-api's `SearchResult` (`doc_etl_api/schemas.py`) that
 * this client reads. The server also returns `source_id` and `source_type` —
 * declare a field here only when something consumes it, so this interface
 * cannot drift into describing fields the server does not actually send.
 */
interface DocEtlSearchResult {
  text?: string;
  source_name?: string;
  score?: number;
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
 */
export async function searchKnowledge(
  query: string,
  topK: number = DEFAULT_TOP_K,
  collections?: string[]
): Promise<KnowledgeSearchOutcome> {
  const url = `${config.docEtl.apiUrl}/search`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), config.docEtl.searchTimeoutMs);

  const requestBody: { query: string; top_k: number; collections?: string[] } = {
    query,
    top_k: topK,
  };
  if (collections?.length) {
    requestBody.collections = collections;
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

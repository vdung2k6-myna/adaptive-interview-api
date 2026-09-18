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

/**
 * Search the document ETL service for relevant knowledge chunks.
 * Returns an empty array on timeout or any HTTP/error failure so that
 * the voice-agent stream never breaks.
 */
export async function searchKnowledge(
  query: string,
  topK: number = DEFAULT_TOP_K
): Promise<KnowledgeChunk[]> {
  const url = `${config.docEtl.apiUrl}/search`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), config.docEtl.searchTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK }),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(
        `[Knowledge] doc-etl-api returned ${response.status} ${response.statusText}`
      );
      return [];
    }

    const data = (await response.json()) as DocEtlSearchResponse;
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

    return results.map((r) => ({
      text: r.text ?? "",
      source: r.source_name ?? "",
      score: r.score,
    }));
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.warn(
      `[Knowledge] doc-etl-api ${isTimeout ? "timed out" : "unreachable"}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

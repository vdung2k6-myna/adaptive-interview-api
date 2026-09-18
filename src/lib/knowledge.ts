import config from "@/lib/config";

export interface KnowledgeChunk {
  text: string;
  source: string;
  score?: number;
}

interface DocEtlSearchResponse {
  results?: Array<{
    text: string;
    source?: string;
    score?: number;
  }>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
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
  const timeoutId = setTimeout(() => abortController.abort(), DEFAULT_TIMEOUT_MS);

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

    return results.map((r) => ({
      text: r.text ?? "",
      source: r.source ?? "unknown",
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

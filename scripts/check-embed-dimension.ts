#!/usr/bin/env tsx
/**
 * Preflight: the configured embedding model must produce the dimension the
 * schema casts to.
 *
 * Reads the dimension from Ollama's /api/show (its *embedding_length field) and
 * falls back to embedding a probe through /api/embed when the metadata does not
 * name it. A model that is unreachable or unnamed is a failure: a preflight that
 * cannot verify must not report success.
 *
 * Usage: npm run check:embed
 */

import "dotenv/config";

import { Client } from "pg";

import config from "../src/lib/config";
import { EMBED_DIMENSION } from "../src/lib/embedding-dimension";

const { baseUrl, embedModel, embedTimeoutMs } = config.ollama;

async function fromShow(): Promise<number | null> {
  const response = await fetch(`${baseUrl}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: embedModel }),
    signal: AbortSignal.timeout(embedTimeoutMs),
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as {
    model_info?: Record<string, unknown>;
  };
  for (const [key, value] of Object.entries(data.model_info ?? {})) {
    if (key.endsWith("embedding_length") && typeof value === "number") {
      return value;
    }
  }
  return null;
}

async function fromEmbed(): Promise<number> {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embedModel, input: "dimension probe" }),
    signal: AbortSignal.timeout(embedTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `/api/embed answered ${response.status} ${response.statusText}`
    );
  }
  const data = (await response.json()) as { embeddings?: number[][] };
  const first = data.embeddings?.[0];
  if (!first) {
    throw new Error("/api/embed returned no embedding");
  }
  return first.length;
}

/**
 * Counts stored rows whose JSON array is not the schema's dimension. The query
 * casts every matching row, so one short row fails the whole scan; the count is
 * metadata only and does not read the embedding or its source content.
 */
async function storedMismatches(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set, so stored embeddings cannot be checked");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ mismatched: string }>(
      "SELECT count(*)::text AS mismatched FROM embeddings WHERE json_array_length(embedding::json) <> $1",
      [EMBED_DIMENSION]
    );
    return Number(result.rows[0]?.mismatched ?? 0);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (!baseUrl) {
    throw new Error("no Ollama base URL is configured");
  }

  const shown = await fromShow();
  const dimension = shown ?? (await fromEmbed());
  const source = shown === null ? "/api/embed" : "/api/show";

  console.log(`embedding model: ${embedModel}`);
  console.log(`dimension (${source}): ${dimension}`);
  console.log(`schema dimension: ${EMBED_DIMENSION}`);

  if (dimension !== EMBED_DIMENSION) {
    console.error(
      `[FAIL] ${embedModel} produces ${dimension}-dimensional vectors, but the schema casts to vector(${EMBED_DIMENSION}). ` +
        `Set OLLAMA_EMBED_MODEL to a ${EMBED_DIMENSION}-dimensional model and regenerate stored embeddings.`
    );
    process.exit(1);
  }

  const mismatched = await storedMismatches();
  console.log(`stored rows with a different dimension: ${mismatched}`);

  if (mismatched > 0) {
    console.error(
      `[FAIL] ${mismatched} stored embedding(s) are not ${EMBED_DIMENSION}-dimensional. ` +
        `The position query casts every matching row, so it will fail until they are regenerated or removed.`
    );
    process.exit(1);
  }

  console.log("[OK] the model and every stored embedding match the schema");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[FAIL] could not verify the embedding dimension: ${message}`);
  process.exit(1);
});

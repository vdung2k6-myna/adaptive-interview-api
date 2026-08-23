import { sql } from "drizzle-orm";
import { db } from "./db";
import { embeddings } from "./schema";

const EMBED_DIMENSION = 1024; // mxbai-embed-large

export async function storeRequirementEmbedding(
  positionId: string,
  requirement: string,
  vector: number[]
): Promise<void> {
  await db.insert(embeddings).values({
    sourceType: "requirement",
    sourceId: positionId,
    sessionId: null,
    content: requirement,
    embedding: JSON.stringify(vector),
  });
}

export async function storeMessageEmbedding(
  sessionId: string,
  messageId: string,
  content: string,
  vector: number[]
): Promise<void> {
  await db.insert(embeddings).values({
    sourceType: "message",
    sourceId: messageId,
    sessionId,
    content,
    embedding: JSON.stringify(vector),
  });
}

export interface CoverageResult {
  content: string;
  minDistance: number | null;
  covered: boolean;
}

export async function getRequirementCoverage(
  sessionId: string,
  positionId: string,
  threshold?: number
): Promise<{ covered: CoverageResult[]; remaining: CoverageResult[] }> {
  const similarityThreshold = threshold ?? parseFloat(process.env.EMBEDDING_SIMILARITY_THRESHOLD || "0.75");
  const distanceThreshold = 1 - similarityThreshold; // cosine distance = 1 - cosine similarity

  const rows = await db.execute(sql`
    SELECT
      r.content AS content,
      MIN(r.embedding::vector(${sql.raw(String(EMBED_DIMENSION))}) <=> m.embedding::vector(${sql.raw(String(EMBED_DIMENSION))})) AS min_distance
    FROM embeddings r
    LEFT JOIN embeddings m
      ON m.source_type = 'message'
      AND m.session_id = ${sessionId}
    WHERE r.source_type = 'requirement'
      AND r.source_id = ${positionId}
    GROUP BY r.id, r.content, r.embedding
  `);

  const covered: CoverageResult[] = [];
  const remaining: CoverageResult[] = [];

  for (const row of rows.rows) {
    const content = String(row.content);
    const minDistance = row.min_distance !== null && row.min_distance !== undefined
      ? parseFloat(String(row.min_distance))
      : null;

    const isCovered = minDistance !== null && minDistance <= distanceThreshold;

    const result: CoverageResult = { content, minDistance, covered: isCovered };

    if (isCovered) {
      covered.push(result);
    } else {
      remaining.push(result);
    }
  }

  return { covered, remaining };
}

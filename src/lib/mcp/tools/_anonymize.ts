import { randomUUID } from "crypto";

/**
 * Stable mapping from real candidate IDs to anonymized UUIDs.
 * Kept in-memory only (per process). If the process restarts, new UUIDs are generated.
 * This is acceptable because these UUIDs are only for MCP client display.
 */
const candidateUuidMap = new Map<string, string>();

/**
 * Return an anonymized stable UUID for a candidate ID.
 */
export function getAnonymizedCandidateUuid(candidateId: string): string {
  if (!candidateUuidMap.has(candidateId)) {
    candidateUuidMap.set(candidateId, randomUUID());
  }
  return candidateUuidMap.get(candidateId)!;
}

/**
 * Strip PII fields from an object. Returns a new object with:
 * - `name` removed
 * - `email` removed
 * - `cv` removed
 * - `rawResponse` removed
 * - `candidateId` replaced with `candidateUuid`
 * - `jobDescription` truncated to 200 chars if present
 */
export function stripPii<T extends Record<string, unknown>>(obj: T): Omit<T, "name" | "email" | "cv" | "rawResponse" | "candidateId"> & { candidateUuid?: string } {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip PII fields entirely
    if (["name", "email", "cv", "rawResponse"].includes(key)) {
      continue;
    }

    // Replace candidateId with candidateUuid
    if (key === "candidateId" && typeof value === "string") {
      result.candidateUuid = getAnonymizedCandidateUuid(value);
      continue;
    }

    // Truncate jobDescription
    if (key === "jobDescription" && typeof value === "string") {
      result[key] = value.substring(0, 200);
      continue;
    }

    result[key] = value;
  }

  return result as unknown as Omit<T, "name" | "email" | "cv" | "rawResponse" | "candidateId"> & { candidateUuid?: string };
}

/**
 * Assert that no PII fields exist in an object. Throws if any are found.
 * Use this in development/tests to catch accidental PII leakage.
 */
export function assertNoPii(obj: unknown, context?: string): void {
  if (typeof obj !== "object" || obj === null) {
    return;
  }

  const forbidden = ["name", "email", "cv", "rawResponse"];
  const found: string[] = [];

  for (const key of Object.keys(obj)) {
    if (forbidden.includes(key)) {
      found.push(key);
    }
  }

  if (found.length > 0) {
    throw new Error(
      `PII leak detected${context ? ` in ${context}` : ""}: forbidden fields [${found.join(", ")}]`
    );
  }
}

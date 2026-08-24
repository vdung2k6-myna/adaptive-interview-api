import { db } from "./db";
import { positions, interviewSessions } from "./schema";
import { eq, count } from "drizzle-orm";

export interface PositionFilter {
  level?: string;
}

/**
 * Load all positions (optionally filtered by level) with the count of
 * interview sessions that reference each position.
 *
 * The returned rows include every `positions` column plus an additive
 * `sessionCount` field, so callers can project their own output shape.
 */
export async function getPositionsWithSessionCount(filter?: PositionFilter) {
  const { level } = filter ?? {};

  const positionRows = level
    ? await db.select().from(positions).where(eq(positions.level, level)).orderBy(positions.createdAt)
    : await db.select().from(positions).orderBy(positions.createdAt);

  const sessionCounts = await db
    .select({
      positionId: interviewSessions.positionId,
      count: count(),
    })
    .from(interviewSessions)
    .groupBy(interviewSessions.positionId);

  const sessionCountMap = new Map(sessionCounts.map((s) => [s.positionId, s.count]));

  return positionRows.map((p) => ({
    ...p,
    sessionCount: sessionCountMap.get(p.id) || 0,
  }));
}

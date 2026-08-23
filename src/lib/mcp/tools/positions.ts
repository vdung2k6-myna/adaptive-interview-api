import { db } from "@/lib/db";
import { positions, interviewSessions } from "@/lib/schema";
import { eq, count } from "drizzle-orm";
import { z } from "zod";

export const listPositionsSchema = z.object({
  level: z.string().optional(),
});

export async function listPositions(args: z.infer<typeof listPositionsSchema>) {
  const { level } = args;

  const positionRows = level
    ? await db.select().from(positions).where(eq(positions.level, level)).orderBy(positions.createdAt)
    : await db.select().from(positions).orderBy(positions.createdAt);

  // Count sessions per position
  const sessionCounts = await db
    .select({
      positionId: interviewSessions.positionId,
      count: count(),
    })
    .from(interviewSessions)
    .groupBy(interviewSessions.positionId);

  const sessionCountMap = new Map(sessionCounts.map((s) => [s.positionId, s.count]));

  return positionRows.map((p) => ({
    id: p.id,
    title: p.title,
    level: p.level,
    requirements: p.requirements,
    sessionCount: sessionCountMap.get(p.id) || 0,
  }));
}

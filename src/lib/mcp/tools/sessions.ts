import { db } from "@/lib/db";
import { interviewSessions, positions, messages, evaluationVersions } from "@/lib/schema";
import { eq, count } from "drizzle-orm";
import { z } from "zod";
import { getAnonymizedCandidateUuid } from "./_anonymize";

export const listSessionsSchema = z.object({
  campaignId: z.string().uuid().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

export const getSessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
});

export async function listSessions(args: z.infer<typeof listSessionsSchema>) {
  const { status, limit } = args;

  // Build base query
  let query = db
    .select({
      session: interviewSessions,
      position: positions,
    })
    .from(interviewSessions)
    .leftJoin(positions, eq(interviewSessions.positionId, positions.id))
    .orderBy(interviewSessions.createdAt)
    .limit(limit);

  if (status) {
    query = query.where(eq(interviewSessions.status, status)) as typeof query;
  }

  const rows = await query;

  return rows.map((row) => ({
    id: row.session.id,
    positionTitle: row.position?.title || "Unknown",
    level: row.position?.level || "Unknown",
    candidateUuid: getAnonymizedCandidateUuid(row.session.candidateId),
    status: row.session.status,
    currentTurn: row.session.currentTurn,
    maxTurns: row.session.maxTurns,
    createdAt: row.session.createdAt,
  }));
}

export async function getSessionSummary(args: z.infer<typeof getSessionSummarySchema>) {
  const { sessionId } = args;

  // Fetch session + position
  const sessionRows = await db
    .select({
      session: interviewSessions,
      position: positions,
    })
    .from(interviewSessions)
    .leftJoin(positions, eq(interviewSessions.positionId, positions.id))
    .where(eq(interviewSessions.id, sessionId));

  if (sessionRows.length === 0) {
    throw new Error("Session not found");
  }

  const { session, position } = sessionRows[0];

  // Count messages
  const messageCountRows = await db
    .select({ count: count() })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));

  const messageCount = messageCountRows[0]?.count || 0;

  // Fetch latest evaluation (AI scores only)
  const evalRows = await db
    .select()
    .from(evaluationVersions)
    .where(eq(evaluationVersions.sessionId, sessionId))
    .orderBy(evaluationVersions.createdAt);

  const latestEval = evalRows.length > 0 ? evalRows[evalRows.length - 1] : null;

  const evaluation = latestEval
    ? {
        scores: {
          technicalDepth: latestEval.aiTechnicalDepth,
          communicationClarity: latestEval.aiCommunicationClarity,
          problemSolving: latestEval.aiProblemSolving,
          relevanceToRole: latestEval.aiRelevanceToRole,
        },
        recommendation: latestEval.aiRecommendation,
        confidence: latestEval.aiConfidence,
        strengths: latestEval.strengths,
        weaknesses: latestEval.weaknesses,
      }
    : undefined;

  return {
    id: session.id,
    positionTitle: position?.title || "Unknown",
    level: position?.level || "Unknown",
    candidateUuid: getAnonymizedCandidateUuid(session.candidateId),
    status: session.status,
    messageCount,
    evaluation,
  };
}

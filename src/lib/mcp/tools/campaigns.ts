import { db } from "@/lib/db";
import { campaigns, campaignPositions, interviewSessions, evaluationVersions } from "@/lib/schema";
import { eq, count, sql } from "drizzle-orm";
import { z } from "zod";

export const listCampaignsSchema = z.object({
  status: z.string().optional(),
});

export const getCampaignAnalyticsSchema = z.object({
  campaignId: z.string().uuid(),
});

export async function listCampaigns(args: z.infer<typeof listCampaignsSchema>) {
  const campaignRows = await db.select().from(campaigns).orderBy(campaigns.createdAt);

  // Get position IDs per campaign
  const cpRows = await db
    .select({
      campaignId: campaignPositions.campaignId,
      positionId: campaignPositions.positionId,
    })
    .from(campaignPositions);

  const positionIdsByCampaign = new Map<string, string[]>();
  for (const row of cpRows) {
    const list = positionIdsByCampaign.get(row.campaignId) || [];
    list.push(row.positionId);
    positionIdsByCampaign.set(row.campaignId, list);
  }

  // Count sessions per position
  const sessionCounts = await db
    .select({
      positionId: interviewSessions.positionId,
      count: count(),
    })
    .from(interviewSessions)
    .groupBy(interviewSessions.positionId);

  const sessionCountMap = new Map(sessionCounts.map((s) => [s.positionId, s.count]));

  let filteredCampaigns = campaignRows;
  if (args.status) {
    filteredCampaigns = campaignRows.filter((c) => c.status === args.status);
  }

  return filteredCampaigns.map((c) => {
    const posIds = positionIdsByCampaign.get(c.id) || [];
    const totalSessions = posIds.reduce(
      (sum, pid) => sum + (sessionCountMap.get(pid) || 0),
      0
    );
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      positionCount: posIds.length,
      sessionCount: totalSessions,
    };
  });
}

export async function getCampaignAnalytics(args: z.infer<typeof getCampaignAnalyticsSchema>) {
  const { campaignId } = args;

  // Verify campaign exists
  const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (campaignRows.length === 0) {
    throw new Error("Campaign not found");
  }

  // Get positions in campaign
  const cpRows = await db
    .select({ positionId: campaignPositions.positionId })
    .from(campaignPositions)
    .where(eq(campaignPositions.campaignId, campaignId));

  const positionIds = cpRows.map((r) => r.positionId);

  if (positionIds.length === 0) {
    return {
      averageScores: {
        technicalDepth: null,
        communicationClarity: null,
        problemSolving: null,
        relevanceToRole: null,
      },
      totalSessions: 0,
      completedSessions: 0,
      topSkills: [],
      weakAreas: [],
    };
  }

  // Get sessions for these positions
  const sessionRows = await db
    .select({ id: interviewSessions.id, status: interviewSessions.status })
    .from(interviewSessions)
    .where(sql`${interviewSessions.positionId} IN (${sql.join(positionIds.map((pid) => sql`${pid}`), sql`, `)})`);

  const sessionIds = sessionRows.map((s) => s.id);

  // Get evaluations
  const evalRows =
    sessionIds.length > 0
      ? await db
          .select()
          .from(evaluationVersions)
          .where(sql`${evaluationVersions.sessionId} IN (${sql.join(sessionIds.map((sid) => sql`${sid}`), sql`, `)})`)
      : [];

  // Pick latest version per session
  const versionMap = new Map<string, typeof evaluationVersions.$inferSelect>();
  for (const v of evalRows) {
    const existing = versionMap.get(v.sessionId);
    if (!existing || new Date(v.createdAt) > new Date(existing.createdAt)) {
      versionMap.set(v.sessionId, v);
    }
  }

  // Aggregate scores
  let techSum = 0, techCount = 0;
  let commSum = 0, commCount = 0;
  let probSum = 0, probCount = 0;
  let relSum = 0, relCount = 0;
  const allStrengths: string[] = [];
  const allWeaknesses: string[] = [];
  let completedSessions = 0;

  for (const sid of sessionIds) {
    const version = versionMap.get(sid);
    if (version) {
      completedSessions++;
      if (version.aiTechnicalDepth !== null) {
        techSum += version.aiTechnicalDepth;
        techCount++;
      }
      if (version.aiCommunicationClarity !== null) {
        commSum += version.aiCommunicationClarity;
        commCount++;
      }
      if (version.aiProblemSolving !== null) {
        probSum += version.aiProblemSolving;
        probCount++;
      }
      if (version.aiRelevanceToRole !== null) {
        relSum += version.aiRelevanceToRole;
        relCount++;
      }
      allStrengths.push(...version.strengths);
      allWeaknesses.push(...version.weaknesses);
    }
  }

  // Count frequency of strengths/weaknesses
  const strengthCounts = countFrequencies(allStrengths);
  const weaknessCounts = countFrequencies(allWeaknesses);

  return {
    averageScores: {
      technicalDepth: techCount > 0 ? Math.round((techSum / techCount) * 10) / 10 : null,
      communicationClarity: commCount > 0 ? Math.round((commSum / commCount) * 10) / 10 : null,
      problemSolving: probCount > 0 ? Math.round((probSum / probCount) * 10) / 10 : null,
      relevanceToRole: relCount > 0 ? Math.round((relSum / relCount) * 10) / 10 : null,
    },
    totalSessions: sessionIds.length,
    completedSessions,
    topSkills: Object.entries(strengthCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s]) => s),
    weakAreas: Object.entries(weaknessCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s]) => s),
  };
}

function countFrequencies(items: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item] = (counts[item] || 0) + 1;
  }
  return counts;
}

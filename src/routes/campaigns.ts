import { Router } from "express";
import { db } from "@/lib/db";
import {
  campaigns,
  campaignPositions,
  interviewSessions,
  positions,
  evaluationVersions,
  candidates,
} from "@/lib/schema";
import { eq, count, sql } from "drizzle-orm";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const campaignRows = await db.select().from(campaigns).orderBy(campaigns.createdAt);

    // Count sessions per campaign (via positions)
    const positionRows = await db
      .select({
        campaignId: campaignPositions.campaignId,
        positionId: campaignPositions.positionId,
      })
      .from(campaignPositions);

    const positionIdsByCampaign = new Map<string, string[]>();
    for (const row of positionRows) {
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

    const results = campaignRows.map((c) => {
      const posIds = positionIdsByCampaign.get(c.id) || [];
      const totalSessions = posIds.reduce((sum, pid) => sum + (sessionCountMap.get(pid) || 0), 0);
      return {
        ...c,
        positionCount: posIds.length,
        sessionCount: totalSessions,
      };
    });

    res.json(results);
  } catch (err) {
    console.error("GET /api/campaigns error:", err);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, description, startDate, endDate, tags, status, positionIds } = req.body;

    if (!name?.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const [campaign] = await db
      .insert(campaigns)
      .values({
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
        status: status || "draft",
      })
      .returning();

    if (Array.isArray(positionIds) && positionIds.length > 0) {
      await db.insert(campaignPositions).values(
        positionIds.map((pid: unknown) => ({
          campaignId: campaign.id,
          positionId: String(pid),
        }))
      );
    }

    res.status(201).json(campaign);
  } catch (err) {
    console.error("POST /api/campaigns error:", err);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Campaign
    const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, id));
    if (campaignRows.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const campaign = campaignRows[0];

    // 2. Positions in campaign
    const cpRows = await db
      .select({ position: positions })
      .from(campaignPositions)
      .leftJoin(positions, eq(campaignPositions.positionId, positions.id))
      .where(eq(campaignPositions.campaignId, id));

    const campaignPositionsList = cpRows.map((r) => r.position).filter(Boolean);
    const positionIds = campaignPositionsList.map((p) => p!.id);

    // 3. Sessions for positions in campaign
    const sessionRows =
      positionIds.length > 0
        ? await db
            .select({
              id: interviewSessions.id,
              positionId: interviewSessions.positionId,
              candidateId: interviewSessions.candidateId,
            })
            .from(interviewSessions)
            .where(sql`${interviewSessions.positionId} IN (${sql.join(positionIds.map((pid) => sql`${pid}`), sql`, `)})`)
        : [];

    const sessionIds = sessionRows.map((s) => s.id);

    // 4. Evaluations (latest version per session)
    const evalRows =
      sessionIds.length > 0
        ? await db
            .select()
            .from(evaluationVersions)
            .where(sql`${evaluationVersions.sessionId} IN (${sql.join(sessionIds.map((sid) => sql`${sid}`), sql`, `)})`)
        : [];

    const versionMap = new Map<string, typeof evaluationVersions.$inferSelect>();
    for (const v of evalRows) {
      const existing = versionMap.get(v.sessionId);
      if (!existing || new Date(v.createdAt) > new Date(existing.createdAt)) {
        versionMap.set(v.sessionId, v);
      }
    }

    // 5. Metrics
    let totalSessions = 0;
    let completedSessions = 0;
    let aiScoreSum = 0;
    let aiScoreCount = 0;
    let humanScoreSum = 0;
    let humanScoreCount = 0;
    const recCounts: Record<string, number> = {};

    for (const sid of sessionIds) {
      totalSessions++;
      const version = versionMap.get(sid);
      if (version) {
        completedSessions++;
        const aiScores = [
          version.aiTechnicalDepth,
          version.aiCommunicationClarity,
          version.aiProblemSolving,
          version.aiRelevanceToRole,
        ].filter((s): s is number => s !== null);
        if (aiScores.length > 0) {
          aiScoreSum += aiScores.reduce((a, b) => a + b, 0) / aiScores.length;
          aiScoreCount++;
        }
        const humanScores = [
          version.humanTechnicalDepth,
          version.humanCommunicationClarity,
          version.humanProblemSolving,
          version.humanRelevanceToRole,
        ].filter((s): s is number => s !== null);
        if (humanScores.length > 0) {
          humanScoreSum += humanScores.reduce((a, b) => a + b, 0) / humanScores.length;
          humanScoreCount++;
        }
        if (version.aiRecommendation) {
          recCounts[version.aiRecommendation] = (recCounts[version.aiRecommendation] || 0) + 1;
        }
      }
    }

    const avgAiScore = aiScoreCount > 0 ? Math.round((aiScoreSum / aiScoreCount) * 10) / 10 : null;
    const avgHumanScore = humanScoreCount > 0 ? Math.round((humanScoreSum / humanScoreCount) * 10) / 10 : null;
    const completionRate = totalSessions > 0 ? Math.round((completedSessions / totalSessions) * 100) : 0;

    // 6. Top candidates
    const candidateIds = [...new Set(sessionRows.map((s) => s.candidateId).filter(Boolean))];
    const candidateRows =
      candidateIds.length > 0
        ? await db
            .select()
            .from(candidates)
            .where(sql`${candidates.id} IN (${sql.join(candidateIds.map((cid) => sql`${cid}`), sql`, `)})`)
        : [];

    const candidateMap = new Map(candidateRows.map((c) => [c.id, c]));

    const topCandidates = sessionIds
      .map((sid) => {
        const version = versionMap.get(sid);
        if (!version) return null;
        const aiScores = [
          version.aiTechnicalDepth,
          version.aiCommunicationClarity,
          version.aiProblemSolving,
          version.aiRelevanceToRole,
        ].filter((s): s is number => s !== null);
        const humanScores = [
          version.humanTechnicalDepth,
          version.humanCommunicationClarity,
          version.humanProblemSolving,
          version.humanRelevanceToRole,
        ].filter((s): s is number => s !== null);
        const aiAvg = aiScores.length > 0 ? aiScores.reduce((a, b) => a + b, 0) / aiScores.length : null;
        const humanAvg = humanScores.length > 0 ? humanScores.reduce((a, b) => a + b, 0) / humanScores.length : null;
        const sessionRow = sessionRows.find((s) => s.id === sid);
        const candidate = sessionRow?.candidateId ? candidateMap.get(sessionRow.candidateId) : undefined;
        return {
          sessionId: sid,
          candidateName: candidate?.name || "Unknown",
          aiAvg,
          humanAvg,
          recommendation: version.aiRecommendation,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a!.humanAvg !== null && b!.humanAvg !== null) return b!.humanAvg - a!.humanAvg;
        if (a!.humanAvg !== null) return -1;
        if (b!.humanAvg !== null) return 1;
        return (b!.aiAvg || 0) - (a!.aiAvg || 0);
      })
      .slice(0, 5);

    res.json({
      ...campaign,
      positions: campaignPositionsList,
      metrics: {
        totalSessions,
        completionRate,
        avgAiScore,
        avgHumanScore,
      },
      recommendations: recCounts,
      topCandidates,
    });
  } catch (err) {
    console.error("GET /api/campaigns/:id error:", err);
    res.status(500).json({ error: "Failed to fetch campaign" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, startDate, endDate, tags, status } = req.body;

    const existing = await db.select().from(campaigns).where(eq(campaigns.id, id));
    if (existing.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const updateValues: Partial<typeof campaigns.$inferInsert> = {};
    if (name !== undefined) updateValues.name = String(name).trim();
    if (description !== undefined) updateValues.description = description ? String(description).trim() : null;
    if (startDate !== undefined) updateValues.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) updateValues.endDate = endDate ? new Date(endDate) : null;
    if (tags !== undefined) updateValues.tags = Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [];
    if (status !== undefined) updateValues.status = String(status);

    const [updated] = await db
      .update(campaigns)
      .set(updateValues)
      .where(eq(campaigns.id, id))
      .returning();

    res.json(updated);
  } catch (err) {
    console.error("PATCH /api/campaigns/:id error:", err);
    res.status(500).json({ error: "Failed to update campaign" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await db.select().from(campaigns).where(eq(campaigns.id, id));
    if (existing.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    await db.delete(campaigns).where(eq(campaigns.id, id));
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/campaigns/:id error:", err);
    res.status(500).json({ error: "Failed to delete campaign" });
  }
});

export default router;

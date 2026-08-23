import { Router } from "express";
import { db } from "@/lib/db";
import { evaluationVersions, evaluationJobs } from "@/lib/schema";
import { eq, desc } from "drizzle-orm";

const router = Router({ mergeParams: true });

/**
 * GET /api/evaluations
 * Returns all evaluation versions.
 */
router.get("/", async (_req, res) => {
  try {
    const versions = await db
      .select()
      .from(evaluationVersions)
      .orderBy(desc(evaluationVersions.createdAt));

    res.json(versions);
  } catch (err) {
    console.error("GET /api/evaluations error:", err);
    res.status(500).json({ error: "Failed to load evaluations" });
  }
});

/**
 * GET /api/evaluations/:sessionId
 * Returns all evaluation versions for a session, with the latest expanded.
 */
router.get("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const versions = await db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.sessionId, sessionId))
      .orderBy(desc(evaluationVersions.createdAt));

    if (versions.length === 0) {
      res.json({ latest: null, versions: [] });
      return;
    }

    const latest = versions[0];

    res.json({
      latest: {
        id: latest.id,
        sessionId: latest.sessionId,
        model: latest.model,
        aiScores: {
          technicalDepth: latest.aiTechnicalDepth,
          communicationClarity: latest.aiCommunicationClarity,
          problemSolving: latest.aiProblemSolving,
          relevanceToRole: latest.aiRelevanceToRole,
        },
        humanScores: {
          technicalDepth: latest.humanTechnicalDepth,
          communicationClarity: latest.humanCommunicationClarity,
          problemSolving: latest.humanProblemSolving,
          relevanceToRole: latest.humanRelevanceToRole,
        },
        aiRecommendation: latest.aiRecommendation,
        humanRecommendation: latest.humanRecommendation,
        humanCalibrated: latest.humanCalibrated,
        confidence: latest.aiConfidence,
        strengths: latest.strengths,
        weaknesses: latest.weaknesses,
        recruiterNotes: latest.recruiterNotes,
        rawResponse: latest.rawResponse,
        createdAt: latest.createdAt,
      },
      versions: versions.map((v) => ({
        id: v.id,
        model: v.model,
        humanCalibrated: v.humanCalibrated,
        createdAt: v.createdAt,
      })),
    });
  } catch (err) {
    console.error("GET /api/evaluations/:sessionId error:", err);
    res.status(500).json({ error: "Failed to fetch evaluation" });
  }
});

/**
 * PATCH /api/evaluations/:sessionId
 * Updates human scores and recruiter notes on the latest evaluation version.
 */
router.patch("/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const {
      humanScores,
      humanRecommendation,
      recruiterNotes,
    }: {
      humanScores?: {
        technicalDepth?: number;
        communicationClarity?: number;
        problemSolving?: number;
        relevanceToRole?: number;
      };
      humanRecommendation?: string;
      recruiterNotes?: string;
    } = req.body;

    // Find the latest version for this session
    const versions = await db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.sessionId, sessionId))
      .orderBy(desc(evaluationVersions.createdAt))
      .limit(1);

    if (versions.length === 0) {
      res.status(404).json({ error: "Evaluation not found" });
      return;
    }

    const latest = versions[0];

    const updateData: Partial<typeof evaluationVersions.$inferInsert> = {};

    if (humanScores) {
      if (humanScores.technicalDepth !== undefined)
        updateData.humanTechnicalDepth = humanScores.technicalDepth;
      if (humanScores.communicationClarity !== undefined)
        updateData.humanCommunicationClarity = humanScores.communicationClarity;
      if (humanScores.problemSolving !== undefined)
        updateData.humanProblemSolving = humanScores.problemSolving;
      if (humanScores.relevanceToRole !== undefined)
        updateData.humanRelevanceToRole = humanScores.relevanceToRole;
    }

    if (humanRecommendation !== undefined) {
      updateData.humanRecommendation = humanRecommendation;
    }

    if (recruiterNotes !== undefined) {
      updateData.recruiterNotes = recruiterNotes;
    }

    // Mark as calibrated if any human score or recommendation was provided
    if (humanScores || humanRecommendation !== undefined) {
      updateData.humanCalibrated = true;
    }

    const [updated] = await db
      .update(evaluationVersions)
      .set(updateData)
      .where(eq(evaluationVersions.id, latest.id))
      .returning();

    res.json({
      latest: {
        id: updated.id,
        sessionId: updated.sessionId,
        model: updated.model,
        aiScores: {
          technicalDepth: updated.aiTechnicalDepth,
          communicationClarity: updated.aiCommunicationClarity,
          problemSolving: updated.aiProblemSolving,
          relevanceToRole: updated.aiRelevanceToRole,
        },
        humanScores: {
          technicalDepth: updated.humanTechnicalDepth,
          communicationClarity: updated.humanCommunicationClarity,
          problemSolving: updated.humanProblemSolving,
          relevanceToRole: updated.humanRelevanceToRole,
        },
        aiRecommendation: updated.aiRecommendation,
        humanRecommendation: updated.humanRecommendation,
        humanCalibrated: updated.humanCalibrated,
        confidence: updated.aiConfidence,
        strengths: updated.strengths,
        weaknesses: updated.weaknesses,
        recruiterNotes: updated.recruiterNotes,
        rawResponse: updated.rawResponse,
        createdAt: updated.createdAt,
      },
    });
  } catch (err) {
    console.error("PATCH /api/evaluations/:sessionId error:", err);
    res.status(500).json({ error: "Failed to update evaluation" });
  }
});

router.get("/versions/:versionId", async (req, res) => {
  try {
    const { versionId } = req.params;

    const rows = await db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.id, versionId));

    if (rows.length === 0) {
      res.status(404).json({ error: "Version not found" });
      return;
    }

    const v = rows[0];

    res.json({
      id: v.id,
      sessionId: v.sessionId,
      model: v.model,
      aiScores: {
        technicalDepth: v.aiTechnicalDepth,
        communicationClarity: v.aiCommunicationClarity,
        problemSolving: v.aiProblemSolving,
        relevanceToRole: v.aiRelevanceToRole,
      },
      humanScores: {
        technicalDepth: v.humanTechnicalDepth,
        communicationClarity: v.humanCommunicationClarity,
        problemSolving: v.humanProblemSolving,
        relevanceToRole: v.humanRelevanceToRole,
      },
      aiRecommendation: v.aiRecommendation,
      humanRecommendation: v.humanRecommendation,
      humanCalibrated: v.humanCalibrated,
      confidence: v.aiConfidence,
      strengths: v.strengths,
      weaknesses: v.weaknesses,
      recruiterNotes: v.recruiterNotes,
      rawResponse: v.rawResponse,
      createdAt: v.createdAt,
    });
  } catch (err) {
    console.error("GET /api/evaluations/versions/:versionId error:", err);
    res.status(500).json({ error: "Failed to fetch evaluation version" });
  }
});

router.delete("/versions/:versionId", async (req, res) => {
  try {
    const { versionId } = req.params;

    const versionRows = await db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.id, versionId));

    if (versionRows.length === 0) {
      res.status(404).json({ error: "Version not found" });
      return;
    }

    const version = versionRows[0];
    const sessionId = version.sessionId;

    const latestRows = await db
      .select()
      .from(evaluationVersions)
      .where(eq(evaluationVersions.sessionId, sessionId))
      .orderBy(desc(evaluationVersions.createdAt))
      .limit(1);

    const latest = latestRows[0];
    if (latest.id === versionId) {
      res.status(400).json({ error: "Cannot delete the latest evaluation version" });
      return;
    }

    await db.delete(evaluationVersions).where(eq(evaluationVersions.id, versionId));
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/evaluations/versions/:versionId error:", err);
    res.status(500).json({ error: "Failed to delete evaluation version" });
  }
});

/**
 * GET /api/evaluations/jobs/:jobId
 * Returns the status of an async evaluation job.
 */
router.get("/jobs/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobRows = await db
      .select()
      .from(evaluationJobs)
      .where(eq(evaluationJobs.id, jobId));

    if (jobRows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const job = jobRows[0];

    const response: Record<string, unknown> = {
      id: job.id,
      sessionId: job.sessionId,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };

    if (job.status === "completed") {
      response.resultId = job.resultId;

      // If resultId exists, fetch the evaluation result
      if (job.resultId) {
        const resultRows = await db
          .select()
          .from(evaluationVersions)
          .where(eq(evaluationVersions.id, job.resultId));

        if (resultRows.length > 0) {
          const v = resultRows[0];
          response.result = {
            id: v.id,
            aiScores: {
              technicalDepth: v.aiTechnicalDepth,
              communicationClarity: v.aiCommunicationClarity,
              problemSolving: v.aiProblemSolving,
              relevanceToRole: v.aiRelevanceToRole,
            },
            aiRecommendation: v.aiRecommendation,
            confidence: v.aiConfidence,
            strengths: v.strengths,
            weaknesses: v.weaknesses,
            createdAt: v.createdAt,
          };
        }
      }
    } else if (job.status === "failed") {
      response.error = job.error;
    }

    res.json(response);
  } catch (err) {
    console.error("GET /api/evaluations/jobs/:jobId error:", err);
    res.status(500).json({ error: "Failed to fetch evaluation job" });
  }
});

export default router;

import { Router } from "express";
import { db } from "@/lib/db";
import { interviewSessions, candidates, positions, messages, evaluationVersions } from "@/lib/schema";
import { eq, desc, sql } from "drizzle-orm";
import { generateEvaluation } from "@/lib/evaluation";
import { OllamaError } from "@/lib/errors";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    // Fetch all sessions ordered by newest first
    let query = db.select().from(interviewSessions).orderBy(desc(interviewSessions.createdAt));
    if (status) {
      query = query.where(eq(interviewSessions.status, status)) as typeof query;
    }
    const sessionRows = await query;

    // Fetch candidates for all sessions
    const candidateIds = [...new Set(sessionRows.map((s) => s.candidateId))];
    const candidateRows =
      candidateIds.length > 0
        ? await db.select().from(candidates).where(sql`${candidates.id} IN (${sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)})`)
        : [];
    const candidateMap = new Map(candidateRows.map((c) => [c.id, c]));

    // Fetch positions for all sessions
    const positionIds = [...new Set(sessionRows.map((s) => s.positionId))];
    const positionRows =
      positionIds.length > 0
        ? await db.select().from(positions).where(sql`${positions.id} IN (${sql.join(positionIds.map((id) => sql`${id}`), sql`, `)})`)
        : [];
    const positionMap = new Map(positionRows.map((p) => [p.id, p]));

    // Fetch latest evaluation per session
    const sessionIds = sessionRows.map((s) => s.id);
    const evalRows =
      sessionIds.length > 0
        ? await db
            .select()
            .from(evaluationVersions)
            .where(sql`${evaluationVersions.sessionId} IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})`)
        : [];

    const evalMap = new Map<string, typeof evaluationVersions.$inferSelect>();
    for (const ev of evalRows) {
      const existing = evalMap.get(ev.sessionId);
      if (!existing || new Date(ev.createdAt) > new Date(existing.createdAt)) {
        evalMap.set(ev.sessionId, ev);
      }
    }

    const results = sessionRows.map((session) => {
      const candidate = candidateMap.get(session.candidateId) ?? null;
      const position = positionMap.get(session.positionId) ?? null;
      const evaluation = evalMap.get(session.id);

      return {
        ...session,
        candidate: candidate
          ? {
              id: candidate.id,
              name: candidate.name,
              email: candidate.email,
            }
          : null,
        position: position
          ? {
              id: position.id,
              title: position.title,
              level: position.level,
            }
          : null,
        evaluation: evaluation
          ? {
              overallScore:
                evaluation.aiTechnicalDepth != null &&
                evaluation.aiCommunicationClarity != null &&
                evaluation.aiProblemSolving != null &&
                evaluation.aiRelevanceToRole != null
                  ? Math.round(
                      ((evaluation.aiTechnicalDepth +
                        evaluation.aiCommunicationClarity +
                        evaluation.aiProblemSolving +
                        evaluation.aiRelevanceToRole) /
                        4) *
                        10
                    ) / 10
                  : null,
              humanOverallScore:
                evaluation.humanTechnicalDepth != null &&
                evaluation.humanCommunicationClarity != null &&
                evaluation.humanProblemSolving != null &&
                evaluation.humanRelevanceToRole != null
                  ? Math.round(
                      ((evaluation.humanTechnicalDepth +
                        evaluation.humanCommunicationClarity +
                        evaluation.humanProblemSolving +
                        evaluation.humanRelevanceToRole) /
                        4) *
                        10
                    ) / 10
                  : null,
              recommendation: evaluation.aiRecommendation,
              humanCalibrated: evaluation.humanCalibrated ?? false,
            }
          : null,
      };
    });

    // Apply search filter if provided
    if (search) {
      const q = search.toLowerCase();
      const filtered = results.filter((s) => {
        const name = s.candidate?.name?.toLowerCase() || "";
        const email = s.candidate?.email?.toLowerCase() || "";
        const title = s.position?.title?.toLowerCase() || "";
        return name.includes(q) || email.includes(q) || title.includes(q);
      });
      res.json(filtered);
      return;
    }

    res.json(results);
  } catch (err) {
    console.error("GET /api/sessions error:", err);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { positionId, candidateId, mode, ttsProvider } = req.body;
    if (!positionId || !candidateId) {
      res.status(400).json({ error: "positionId and candidateId are required" });
      return;
    }

    const session = await db
      .insert(interviewSessions)
      .values({
        positionId,
        candidateId,
        mode: mode || "text",
        ttsProvider: ttsProvider || "kokoro",
      })
      .returning();

    res.status(201).json(session[0]);
  } catch (err) {
    console.error("POST /api/sessions error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sessionRows = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, id));

    if (sessionRows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const session = sessionRows[0];

    const candidateRows = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, session.candidateId));

    const positionRows = await db
      .select()
      .from(positions)
      .where(eq(positions.id, session.positionId));

    const messageRows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, id))
      .orderBy(messages.createdAt);

    res.json({
      session,
      candidate: candidateRows[0] ?? null,
      position: positionRows[0] ?? null,
      messages: messageRows,
    });
  } catch (err) {
    console.error("GET /api/sessions/:id error:", err);
    res.status(500).json({ error: "Failed to load session" });
  }
});

router.post("/:id/evaluate", async (req, res) => {
  try {
    const { id } = req.params;
    const { model } = req.body as { model?: string };
    const evaluation = await generateEvaluation(id, model);
    res.json(evaluation);
  } catch (err) {
    console.error("POST /api/sessions/:id/evaluate error:", err);

    if (err instanceof Error) {
      if (err.message === "Interview is not completed") {
        res.status(400).json({ error: "Interview must be completed before evaluation" });
        return;
      }
      if (err.message === "Session not found") {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (err.message === "No messages found for session") {
        res.status(400).json({ error: "No interview transcript found" });
        return;
      }
    }

    if (err instanceof OllamaError) {
      res.status(err.statusCode || 503).json({ error: `Ollama error: ${err.message}` });
      return;
    }

    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to generate evaluation" });
  }
});

export default router;

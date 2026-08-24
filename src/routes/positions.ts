import { Router } from "express";
import { db } from "@/lib/db";
import { positions, interviewSessions, embeddings } from "@/lib/schema";
import { eq, count } from "drizzle-orm";
import { embedText } from "@/lib/ollama";
import { storeRequirementEmbedding } from "@/lib/embeddings";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { title, level, requirements, jobDescription } = req.body;

    if (!title || !level || !Array.isArray(requirements) || requirements.length === 0) {
      res.status(400).json({ error: "title, level, and at least one requirement are required" });
      return;
    }

    const trimmedReqs = requirements.map((r: unknown) => String(r).trim()).filter(Boolean);

    const position = await db
      .insert(positions)
      .values({
        title: String(title).trim(),
        level: String(level).trim(),
        requirements: trimmedReqs,
        jobDescription: jobDescription ? String(jobDescription).trim() : null,
      })
      .returning();

    // Generate embeddings for each requirement
    for (const reqText of trimmedReqs) {
      try {
        const embedding = await embedText(reqText);
        await storeRequirementEmbedding(position[0].id, reqText, embedding);
      } catch {
        // Non-fatal: embeddings can fail
      }
    }

    res.status(201).json(position[0]);
  } catch (err) {
    console.error("POST /api/positions error:", err);
    res.status(500).json({ error: "Failed to create position" });
  }
});

router.get("/", async (_req, res) => {
  try {
    const rows = await db.select().from(positions).orderBy(positions.createdAt);

    // Count sessions per position
    const sessionCounts = await db
      .select({
        positionId: interviewSessions.positionId,
        count: count(),
      })
      .from(interviewSessions)
      .groupBy(interviewSessions.positionId);

    const sessionCountMap = new Map(sessionCounts.map((s) => [s.positionId, s.count]));

    const results = rows.map((p) => ({
      ...p,
      sessionCount: sessionCountMap.get(p.id) || 0,
    }));

    res.json(results);
  } catch (err) {
    console.error("GET /api/positions error:", err);
    res.status(500).json({ error: "Failed to load positions" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await db.select().from(positions).where(eq(positions.id, id));
    if (rows.length === 0) {
      res.status(404).json({ error: "Position not found" });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/positions/:id error:", err);
    res.status(500).json({ error: "Failed to fetch position" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await db.select().from(positions).where(eq(positions.id, id));
    if (existing.length === 0) {
      res.status(404).json({ error: "Position not found" });
      return;
    }

    const sessionCount = await db
      .select({ count: count() })
      .from(interviewSessions)
      .where(eq(interviewSessions.positionId, id));
    if (sessionCount[0].count > 0) {
      res.status(409).json({ error: "Cannot edit position that is referenced by existing sessions" });
      return;
    }

    const { title, level, requirements, jobDescription } = req.body;

    const updateValues: Partial<typeof positions.$inferInsert> = {};
    if (title !== undefined) updateValues.title = String(title).trim();
    if (level !== undefined) updateValues.level = String(level).trim();
    if (requirements !== undefined && Array.isArray(requirements)) {
      updateValues.requirements = requirements.map((r: unknown) => String(r).trim()).filter(Boolean);
    }
    if (jobDescription !== undefined) {
      updateValues.jobDescription = jobDescription ? String(jobDescription).trim() : null;
    }

    const [updated] = await db
      .update(positions)
      .set(updateValues)
      .where(eq(positions.id, id))
      .returning();

    // Regenerate embeddings if requirements changed
    if (requirements !== undefined && Array.isArray(requirements)) {
      // Delete old requirement embeddings
      await db.delete(embeddings).where(eq(embeddings.sourceId, id));

      for (const reqText of updateValues.requirements || []) {
        try {
          const embedding = await embedText(reqText);
          await storeRequirementEmbedding(updated.id, reqText, embedding);
        } catch {
          // Non-fatal: embeddings can fail
        }
      }
    }

    res.json(updated);
  } catch (err) {
    console.error("PATCH /api/positions/:id error:", err);
    res.status(500).json({ error: "Failed to update position" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await db.select().from(positions).where(eq(positions.id, id));
    if (existing.length === 0) {
      res.status(404).json({ error: "Position not found" });
      return;
    }

    const sessionCount = await db
      .select({ count: count() })
      .from(interviewSessions)
      .where(eq(interviewSessions.positionId, id));
    if (sessionCount[0].count > 0) {
      res.status(409).json({ error: "Cannot delete position that is referenced by existing sessions" });
      return;
    }

    // Delete requirement embeddings for this position
    await db.delete(embeddings).where(eq(embeddings.sourceId, id));

    await db.delete(positions).where(eq(positions.id, id));
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/positions/:id error:", err);
    res.status(500).json({ error: "Failed to delete position" });
  }
});

export default router;

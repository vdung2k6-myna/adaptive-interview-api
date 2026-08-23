import { Router } from "express";
import { db } from "@/lib/db";
import { candidates, interviewSessions } from "@/lib/schema";
import { eq, count } from "drizzle-orm";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { name, email, skills, experienceYears, cv } = req.body;

    if (!name || !email || !Array.isArray(skills) || skills.length === 0) {
      res.status(400).json({ error: "name, email, and at least one skill are required" });
      return;
    }

    const candidate = await db
      .insert(candidates)
      .values({
        name: String(name).trim(),
        email: String(email).trim(),
        skills: skills.map((s: unknown) => String(s).trim()).filter(Boolean),
        experienceYears: experienceYears ? Number(experienceYears) : null,
        cv: cv ? String(cv).trim() : null,
      })
      .returning();

    res.status(201).json(candidate[0]);
  } catch (err) {
    console.error("POST /api/candidates error:", err);
    res.status(500).json({ error: "Failed to create candidate" });
  }
});

router.get("/", async (_req, res) => {
  try {
    const rows = await db.select().from(candidates).orderBy(candidates.createdAt);

    const sessionCounts = await db
      .select({ candidateId: interviewSessions.candidateId, count: count() })
      .from(interviewSessions)
      .groupBy(interviewSessions.candidateId);

    const countMap = new Map(sessionCounts.map((s) => [s.candidateId, s.count]));

    const results = rows.map((c) => ({
      ...c,
      sessionCount: countMap.get(c.id) || 0,
    }));

    res.json(results);
  } catch (err) {
    console.error("GET /api/candidates error:", err);
    res.status(500).json({ error: "Failed to load candidates" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await db.select().from(candidates).where(eq(candidates.id, id));
    if (rows.length === 0) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/candidates/:id error:", err);
    res.status(500).json({ error: "Failed to fetch candidate" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await db.select().from(candidates).where(eq(candidates.id, id));
    if (existing.length === 0) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }

    const sessionCount = await db
      .select({ count: count() })
      .from(interviewSessions)
      .where(eq(interviewSessions.candidateId, id));
    if (sessionCount[0].count > 0) {
      res.status(409).json({ error: "Cannot edit candidate that is referenced by existing sessions" });
      return;
    }

    const { name, email, skills, experienceYears, cv } = req.body;

    const updateValues: Partial<typeof candidates.$inferInsert> = {};
    if (name !== undefined) updateValues.name = String(name).trim();
    if (email !== undefined) updateValues.email = String(email).trim();
    if (skills !== undefined && Array.isArray(skills)) {
      updateValues.skills = skills.map((s: unknown) => String(s).trim()).filter(Boolean);
    }
    if (experienceYears !== undefined) {
      updateValues.experienceYears = experienceYears ? Number(experienceYears) : null;
    }
    if (cv !== undefined) {
      updateValues.cv = cv ? String(cv).trim() : null;
    }

    const [updated] = await db
      .update(candidates)
      .set(updateValues)
      .where(eq(candidates.id, id))
      .returning();

    res.json(updated);
  } catch (err) {
    console.error("PATCH /api/candidates/:id error:", err);
    res.status(500).json({ error: "Failed to update candidate" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await db.select().from(candidates).where(eq(candidates.id, id));
    if (existing.length === 0) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }

    const sessionCount = await db
      .select({ count: count() })
      .from(interviewSessions)
      .where(eq(interviewSessions.candidateId, id));
    if (sessionCount[0].count > 0) {
      res.status(409).json({ error: "Cannot delete candidate that is referenced by existing sessions" });
      return;
    }

    await db.delete(candidates).where(eq(candidates.id, id));
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/candidates/:id error:", err);
    res.status(500).json({ error: "Failed to delete candidate" });
  }
});

export default router;

import { Router } from "express";
import { db } from "@/lib/db";
import { interviewSessions, candidates, positions, messages } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { buildPrompt, PromptMessage } from "@/lib/prompts";
import { generateChatResponseStream, embedText } from "@/lib/ollama";
import { storeMessageEmbedding } from "@/lib/embeddings";
import { OllamaError } from "@/lib/errors";

const router = Router();

/**
 * POST /api/messages
 * Handles interview message streaming.
 * - First call with a sessionId and no content → generates first question
 * - Subsequent calls with content → stores candidate answer, generates follow-up
 * - Streams response as text/plain
 */
router.post("/", async (req, res) => {
  try {
    console.log("[POST /api/messages] Request received");
    const { sessionId, content } = req.body as { sessionId?: string; content?: string };
    console.log("[POST /api/messages] Body:", { sessionId, content: content?.substring(0, 50) });

    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const sessionRows = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, sessionId));

    if (sessionRows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const session = sessionRows[0];
    console.log("[POST /api/messages] Session found:", session.id, "status:", session.status);

    if (session.status === "completed") {
      const completionText = "This interview has already concluded.";
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.write(completionText);

      // Store completion message
      await db.insert(messages).values({
        sessionId,
        role: "interviewer",
        content: completionText,
      });

      res.end();
      return;
    }

    const candidateRows = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, session.candidateId));

    const positionRows = await db
      .select()
      .from(positions)
      .where(eq(positions.id, session.positionId));

    const candidate = candidateRows[0];
    const position = positionRows[0];

    if (!candidate || !position) {
      res.status(404).json({ error: "Related candidate or position not found" });
      return;
    }

    const existingMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt);

    // First question generation when no messages exist yet
    if (existingMessages.length === 0) {
      const prompt = await buildPrompt(
        {
          id: session.id,
          positionId: session.positionId,
          status: session.status,
          maxTurns: session.maxTurns,
          currentTurn: session.currentTurn,
          position: {
            title: position.title,
            level: position.level,
            jobDescription: position.jobDescription,
            requirements: position.requirements,
          },
          candidate: {
            name: candidate.name,
            skills: candidate.skills,
            experienceYears: candidate.experienceYears,
            cv: candidate.cv,
          },
        },
        []
      );

      console.log("[POST /api/messages] Calling Ollama for first question (stream)...");
      const { stream, getFullText } = generateChatResponseStream({
        messages: prompt,
        temperature: 0.7,
      });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");

      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }

        const fullText = getFullText();
        console.log("[POST /api/messages] First question stream complete:", fullText.substring(0, 100));

        await db.insert(messages).values({
          sessionId,
          role: "interviewer",
          content: fullText,
        });

        if (session.status === "created") {
          await db
            .update(interviewSessions)
            .set({ status: "in_progress" })
            .where(eq(interviewSessions.id, sessionId));
        }

        res.end();
      } catch (streamErr) {
        console.error("[POST /api/messages] Stream error:", streamErr);
        if (!res.headersSent) {
          res.status(500).json({ error: "Stream failed" });
        } else {
          res.destroy();
        }
      }
      return;
    }

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    // Store candidate answer
    const insertedMessages = await db.insert(messages).values({
      sessionId,
      role: "candidate",
      content: content.trim(),
    }).returning();

    const candidateMessageId = insertedMessages[0].id;

    // Generate and store message embedding (critical path)
    console.log("[POST /api/messages] Generating embedding for candidate message...");
    try {
      const vector = await embedText(content.trim());
      await storeMessageEmbedding(sessionId, candidateMessageId, content.trim(), vector);
      console.log("[POST /api/messages] Embedding stored.");
    } catch (err) {
      console.error("[POST /api/messages] Embedding error:", err);
      if (err instanceof OllamaError) {
        res.status(503).json({ error: `Embedding generation failed: ${err.message}` });
        return;
      }
      throw err;
    }

    const newTurn = session.currentTurn + 1;

    if (newTurn >= session.maxTurns) {
      await db
        .update(interviewSessions)
        .set({ status: "completed", currentTurn: newTurn, completedAt: new Date() })
        .where(eq(interviewSessions.id, sessionId));

      const completionText = "Thank you, the interview is complete.";
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.write(completionText);

      await db.insert(messages).values({
        sessionId,
        role: "interviewer",
        content: completionText,
      });

      res.end();
      return;
    }

    await db
      .update(interviewSessions)
      .set({ currentTurn: newTurn, status: "in_progress" })
      .where(eq(interviewSessions.id, sessionId));

    const promptMessages: PromptMessage[] = existingMessages.map((m) => ({
      role: m.role as "interviewer" | "candidate",
      content: m.content,
    }));
    promptMessages.push({ role: "candidate", content: content.trim() });

    const prompt = await buildPrompt(
      {
        id: session.id,
        positionId: session.positionId,
        status: "in_progress",
        maxTurns: session.maxTurns,
        currentTurn: newTurn,
        position: {
          title: position.title,
          level: position.level,
          jobDescription: position.jobDescription,
          requirements: position.requirements,
        },
        candidate: {
          name: candidate.name,
          skills: candidate.skills,
          experienceYears: candidate.experienceYears,
          cv: candidate.cv,
        },
      },
      promptMessages
    );

    console.log("[POST /api/messages] Calling Ollama for follow-up (stream)...");
    const { stream, getFullText } = generateChatResponseStream({
      messages: prompt,
      temperature: 0.7,
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }

      const fullText = getFullText();
      console.log("[POST /api/messages] Follow-up stream complete:", fullText.substring(0, 100));

      await db.insert(messages).values({
        sessionId,
        role: "interviewer",
        content: fullText,
      });

      res.end();
    } catch (streamErr) {
      console.error("[POST /api/messages] Stream error:", streamErr);
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream failed" });
      } else {
        res.destroy();
      }
    }
  } catch (err) {
    console.error("[POST /api/messages] UNEXPECTED ERROR:", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to process message",
      });
    }
  }
});

export default router;

import { db } from "./db";
import { interviewSessions, candidates, positions, messages, evaluationVersions } from "./schema";
import { eq } from "drizzle-orm";
import { generateChatResponse } from "./ollama";
import { OllamaError } from "./errors";
import config from "./config";

const VALID_RECOMMENDATIONS = ["strong_yes", "yes", "maybe", "no", "strong_no"] as const;

type EvaluationResult = {
  technicalDepth: number;
  communicationClarity: number;
  problemSolving: number;
  relevanceToRole: number;
  strengths: string[];
  weaknesses: string[];
  recommendation: string;
  confidence: number;
};

export async function generateEvaluation(sessionId: string, model?: string) {
  const targetModel = model || process.env.OLLAMA_MODEL || "llama3.1";

  // Fetch session
  const sessionRows = await db
    .select()
    .from(interviewSessions)
    .where(eq(interviewSessions.id, sessionId));
  if (sessionRows.length === 0) {
    throw new Error("Session not found");
  }
  const session = sessionRows[0];

  if (session.status !== "completed") {
    throw new Error("Interview is not completed");
  }

  // Fetch candidate and position
  const [candidateRows, positionRows] = await Promise.all([
    db.select().from(candidates).where(eq(candidates.id, session.candidateId)),
    db.select().from(positions).where(eq(positions.id, session.positionId)),
  ]);
  const candidate = candidateRows[0];
  const position = positionRows[0];

  if (!candidate || !position) {
    throw new Error("Candidate or position not found");
  }

  // Fetch messages
  const messageRows = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(messages.createdAt);

  if (messageRows.length === 0) {
    throw new Error("No messages found for session");
  }

  // Build transcript
  const transcript = messageRows
    .map((m) => {
      const role = m.role === "interviewer" ? "Interviewer" : "Candidate";
      return `${role}: ${m.content}`;
    })
    .join("\n\n");

  const prompt = buildEvaluationPrompt(
    position.title,
    position.level,
    position.jobDescription,
    position.requirements,
    candidate.name,
    candidate.skills,
    candidate.experienceYears,
    transcript
  );

  // Call Ollama with retry
  let rawResponse = "";
  let parsedResult: EvaluationResult | null = null;
  let attempts = 0;
  const maxAttempts = config.evaluation.maxAttempts;

  while (attempts < maxAttempts) {
    try {
      const useStrictPrompt = attempts > 0;
      const finalPrompt = useStrictPrompt
        ? prompt + "\n\nCRITICAL: Respond ONLY with valid JSON. No markdown formatting, no extra text."
        : prompt;

      rawResponse = await generateChatResponse({ messages: [{ role: "user", content: finalPrompt }], temperature: config.evaluation.temperature, model: targetModel });
      parsedResult = parseEvaluationJson(rawResponse);
      if (parsedResult) break;
    } catch (err) {
      if (err instanceof OllamaError) {
        throw err; // Don't retry on Ollama errors
      }
      // Retry on parse failure
    }
    attempts++;
  }

  if (!parsedResult) {
    // Store raw response as failed evaluation
    const [evalRow] = await db
      .insert(evaluationVersions)
      .values({
        sessionId,
        model: targetModel,
        rawResponse: rawResponse!,
        strengths: [],
        weaknesses: [],
      })
      .returning();
    return evalRow;
  }

  const [evalRow] = await db
    .insert(evaluationVersions)
    .values({
      sessionId,
      model: targetModel,
      rawResponse,
      aiTechnicalDepth: parsedResult.technicalDepth,
      aiCommunicationClarity: parsedResult.communicationClarity,
      aiProblemSolving: parsedResult.problemSolving,
      aiRelevanceToRole: parsedResult.relevanceToRole,
      strengths: parsedResult.strengths,
      weaknesses: parsedResult.weaknesses,
      aiRecommendation: parsedResult.recommendation,
      aiConfidence: parsedResult.confidence,
    })
    .returning();

  return evalRow;
}

function buildEvaluationPrompt(
  title: string,
  level: string,
  jobDescription: string | null,
  requirements: string[],
  candidateName: string,
  skills: string[],
  experienceYears: number | null,
  transcript: string
): string {
  const jobDescSection = jobDescription
    ? `\nJob Description:\n${jobDescription.substring(0, 1200)}`
    : "";

  return `You are an experienced technical hiring manager reviewing an interview transcript.

Position: ${title} (${level})${jobDescSection}
Requirements: ${requirements.join(", ")}
Candidate: ${candidateName}
Skills: ${skills.join(", ")}
Experience: ${experienceYears ?? "N/A"} years

Interview transcript:
${transcript}

Evaluate the candidate on these dimensions (1-5 scale, where 1 = poor, 5 = excellent):
- technical_depth: depth of technical knowledge demonstrated
- communication_clarity: how clearly they explained their reasoning
- problem_solving: ability to think through problems systematically
- relevance_to_role: how well their experience matches the position

Also provide:
- strengths: array of 2-5 specific strengths observed
- weaknesses: array of 2-5 specific weaknesses or gaps
- recommendation: one of [strong_yes, yes, maybe, no, strong_no]
- confidence: 0-100 (how confident you are in this assessment)

Respond ONLY with valid JSON in this exact format:
{
  "technical_depth": 4,
  "communication_clarity": 3,
  "problem_solving": 4,
  "relevance_to_role": 5,
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "recommendation": "yes",
  "confidence": 78
}`;
}

function parseEvaluationJson(raw: string): EvaluationResult | null {
  try {
    // Extract JSON block
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (
      typeof parsed.technical_depth !== "number" ||
      typeof parsed.communication_clarity !== "number" ||
      typeof parsed.problem_solving !== "number" ||
      typeof parsed.relevance_to_role !== "number" ||
      !Array.isArray(parsed.strengths) ||
      !Array.isArray(parsed.weaknesses) ||
      typeof parsed.recommendation !== "string" ||
      typeof parsed.confidence !== "number"
    ) {
      return null;
    }

    // Validate ranges
    const scores = [parsed.technical_depth, parsed.communication_clarity, parsed.problem_solving, parsed.relevance_to_role];
    if (scores.some((s) => s < 1 || s > 5 || !Number.isInteger(s))) return null;
    if (parsed.confidence < 0 || parsed.confidence > 100 || !Number.isInteger(parsed.confidence)) return null;
    if (!VALID_RECOMMENDATIONS.includes(parsed.recommendation)) return null;

    return {
      technicalDepth: parsed.technical_depth,
      communicationClarity: parsed.communication_clarity,
      problemSolving: parsed.problem_solving,
      relevanceToRole: parsed.relevance_to_role,
      strengths: parsed.strengths.filter((s: unknown) => typeof s === "string"),
      weaknesses: parsed.weaknesses.filter((s: unknown) => typeof s === "string"),
      recommendation: parsed.recommendation,
      confidence: parsed.confidence,
    };
  } catch {
    return null;
  }
}

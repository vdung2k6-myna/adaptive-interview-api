import { OllamaMessage } from "./ollama";
import { getRequirementCoverage } from "./embeddings";

export interface PromptSession {
  id: string;
  positionId: string;
  status: string;
  maxTurns: number;
  currentTurn: number;
  position: {
    title: string;
    level: string;
    jobDescription?: string | null;
    requirements: string[];
  };
  candidate: {
    name: string;
    skills: string[];
    experienceYears: number | null;
    cv?: string | null;
  };
}

export interface PromptMessage {
  role: "interviewer" | "candidate";
  content: string;
}

/**
 * Maximum total characters for the assistant/user turn history.
 * This is a hard failsafe to avoid exceeding the model's context window.
 * System message, context user message, and final task message are never trimmed.
 */
const DEFAULT_MAX_PROMPT_TURN_CHARS = 24_000;

function getMaxPromptTurnChars(): number {
  const env = process.env.MAX_PROMPT_TURN_CHARS;
  if (!env) return DEFAULT_MAX_PROMPT_TURN_CHARS;
  const parsed = parseInt(env, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_MAX_PROMPT_TURN_CHARS : parsed;
}

function buildSystemPrompt(): string {
  return `You are an experienced technical interviewer conducting a structured interview.

Rules:
- Generate one concise interview question at a time.
- No preamble, no explanation.
- Use Markdown formatting.
- If you include code examples, specify the language after the opening backticks (e.g., \`\`\`python, \`\`\`go).
- Keep questions relevant to the position requirements and the candidate's background.
- When generating questions for voice interviews, spell out numbers as Vietnamese words (e.g., "ba năm" instead of "3 năm").
- You are the interviewer in this conversation.`;
}

function buildContextUserPrompt(session: PromptSession, coveredTopics: string[], remainingTopics: string[]): string {
  const cvSection = session.candidate.cv
    ? `\nCandidate CV summary:\n${session.candidate.cv.substring(0, 800)}`
    : "";

  const jobDescSection = session.position.jobDescription
    ? `\nJob Description:\n${session.position.jobDescription.substring(0, 1200)}`
    : "";

  return `Position: ${session.position.title} (${session.position.level})${jobDescSection}
Requirements: ${session.position.requirements.join(", ")}

Candidate: ${session.candidate.name}
Skills: ${session.candidate.skills.join(", ")}
Experience: ${session.candidate.experienceYears ?? "N/A"} years${cvSection}

Topics already covered: ${coveredTopics.join(", ") || "None yet"}
Remaining topics to explore: ${remainingTopics.join(", ") || "None — feel free to dig deeper on covered topics or ask behavioral questions"}

The candidate has completed ${session.currentTurn} of ${session.maxTurns} turns.`;
}

function buildTurnMessages(messages: PromptMessage[]): OllamaMessage[] {
  return messages.map((msg) => ({
    role: msg.role === "interviewer" ? "assistant" : "user",
    content: msg.content,
  }));
}

/**
 * Trim the oldest middle turns when the combined turn history exceeds the
 * configured character budget. Keeps the first turn and the most recent turns.
 * System message, context message, and final task message are not counted or trimmed.
 */
function trimTurnMessages(turns: OllamaMessage[], maxChars: number): OllamaMessage[] {
  const totalChars = turns.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= maxChars) return turns;
  if (turns.length <= 2) return turns; // nothing to drop from the middle

  const first = turns[0];
  const last = turns[turns.length - 1];
  const middle = turns.slice(1, -1);

  let middleChars = middle.reduce((sum, m) => sum + m.content.length, 0);
  let keepCount = 0;
  // Keep newest middle turns first
  for (let i = middle.length - 1; i >= 0; i--) {
    const nextChars = middle[i].content.length;
    if (middleChars + nextChars > maxChars) {
      break;
    }
    middleChars += nextChars;
    keepCount++;
  }

  const keptMiddle = middle.slice(middle.length - keepCount);
  return [first, ...keptMiddle, last];
}

export async function buildPrompt(
  session: PromptSession,
  messages: PromptMessage[]
): Promise<OllamaMessage[]> {
  const coverage = await getRequirementCoverage(session.id, session.positionId);

  const coveredTopics = coverage.covered.map((c) => c.content);
  const remainingTopics = coverage.remaining.map((r) => r.content);

  const systemPrompt = buildSystemPrompt();
  const contextPrompt = buildContextUserPrompt(session, coveredTopics, remainingTopics);
  const turnMessages = buildTurnMessages(messages);
  const trimmedTurns = trimTurnMessages(turnMessages, getMaxPromptTurnChars());

  const ollamaMessages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: contextPrompt },
    ...trimmedTurns,
    { role: "user", content: "Generate the next interview question." },
  ];

  return ollamaMessages;
}

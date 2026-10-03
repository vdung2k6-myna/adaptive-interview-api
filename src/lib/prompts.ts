import { OllamaMessage } from "./ollama";
import { getRequirementCoverage } from "./embeddings";
import { KnowledgeChunk } from "./knowledge";

export interface PromptSession {
  id: string;
  positionId: string;
  status: string;
  language: "english" | "vietnamese";
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
 *
 * This bounds how much of the interview reaches the model. It does not protect
 * the model's context window, which is far larger than this: the local model
 * loads at 131k tokens and the cloud one ignores `num_ctx` outright, against
 * ~13,500 tokens worst case here.
 *
 * The first and last turns are kept unconditionally, so they are spent from this
 * budget before the middle competes for what is left. When those two alone
 * exceed it the history is returned as just those two turns and the budget is
 * exceeded — a turn with no history is worse than one over budget.
 *
 * The system message, context user message, and final task message are never
 * counted or trimmed.
 */
const DEFAULT_MAX_PROMPT_TURN_CHARS = 24_000;

function getMaxPromptTurnChars(): number {
  const env = process.env.MAX_PROMPT_TURN_CHARS;
  if (!env) return DEFAULT_MAX_PROMPT_TURN_CHARS;
  const parsed = parseInt(env, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_MAX_PROMPT_TURN_CHARS : parsed;
}

function buildSystemPrompt(language: "english" | "vietnamese" = "english"): string {
  const lang = language.charAt(0).toUpperCase().concat(language.slice(1));
  const languageInstruction = `- Conduct the entire interview in ${lang}. Questions, explanations, and replies must be in ${lang} only.`;

  return `You are an experienced technical interviewer conducting a structured interview.

Rules:
- Generate one concise interview question at a time.
- No preamble, no explanation.
- Use Markdown formatting.
- Keep questions relevant to the position requirements and the candidate's background.
- Prioritize technical questions that probe the position requirements and the candidate's stated skills.
- Ask behavioral or situational questions only as natural follow-ups to a technical answer, or after the core technical requirements have been covered.
- You are the interviewer in this conversation.
${languageInstruction}`;
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
 * Trim the middle turns when the combined turn history exceeds the configured
 * character budget. The first and last turns are kept unconditionally and are
 * charged against the budget; the newest middle turns are then kept while they
 * fit in what remains, so a turn costs one message at the boundary rather than
 * the whole middle.
 *
 * Returns the history unchanged when it is within budget, or when it is short
 * enough that there is no middle to drop. Retention is per message rather than
 * per exchange, so a kept middle can begin mid-exchange: an answer can arrive
 * without the question it responds to.
 */
export function trimTurnMessages(turns: OllamaMessage[], maxChars: number): OllamaMessage[] {
  const totalChars = turns.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= maxChars) return turns;
  if (turns.length <= 2) return turns; // nothing to drop from the middle

  const first = turns[0];
  const last = turns[turns.length - 1];
  const middle = turns.slice(1, -1);

  // What the budget has left for the middle, once the two ends have taken theirs.
  let remaining = maxChars - first.content.length - last.content.length;
  let keepCount = 0;
  // Keep newest middle turns first
  for (let i = middle.length - 1; i >= 0; i--) {
    const nextChars = middle[i].content.length;
    if (nextChars > remaining) {
      break;
    }
    remaining -= nextChars;
    keepCount++;
  }

  const keptMiddle = middle.slice(middle.length - keepCount);
  return [first, ...keptMiddle, last];
}

export interface VoiceAgentMessage {
  role: "agent" | "user";
  content: string;
}

/**
 * Format knowledge chunks as a numbered list with source attribution.
 * Example: `1. [interview-guide.pdf] The STAR method is...`
 */
export function formatKnowledgeChunks(chunks: KnowledgeChunk[]): string {
  if (!chunks.length) return "";
  const lines = chunks.map(
    (chunk, idx) => `${idx + 1}. [${chunk.source}] ${chunk.text}`
  );
  return `Relevant knowledge:\n${lines.join("\n")}`;
}

/**
 * The directive that turns retrieved chunks from ambient context into the basis
 * for the reply.
 *
 * It belongs to the knowledge section rather than the `Rules:` block so that it
 * exists exactly when the section does: a turn with no chunks gets the prompt it
 * would get with no retrieval at all (design D1).
 *
 * It asks for no citation. The reply is spoken, and a bracketed source name the
 * model echoes reaches synthesis — `stripMarkdown` has no rule for a bare
 * `[token]` — so a citation would be read aloud (design D5).
 *
 * "when it is relevant" and "reply as you normally would" carry the personas
 * that ask rather than answer: the Interview Coach must ground its questions in
 * the material, not lecture from it (design D4).
 */
const KNOWLEDGE_DIRECTIVE =
  "Base your reply on the material above when it is relevant to the conversation. " +
  "Prefer its terminology and specifics over general knowledge, and do not " +
  "contradict it. If it does not cover the topic, reply as you normally would.";

/**
 * Build a generic voice-agent prompt from a user-supplied system prompt,
 * language rule, and conversation history. No position/candidate context.
 * Optional knowledgeContext prepends a "Relevant knowledge:" section to
 * the system prompt, carrying a directive to base the reply on the
 * indexed documents it names.
 */
export function buildVoiceAgentPrompt(
  systemPrompt: string,
  language: "english" | "vietnamese" = "english",
  history: VoiceAgentMessage[] = [],
  knowledgeContext?: KnowledgeChunk[]
): OllamaMessage[] {
  const languageInstruction = `- Conduct the entire conversation in ${language}. Replies must be in ${language} only.`;

  // The section's own text is the only place that exists exactly when chunks do,
  // so the directive rides inside it rather than in the unconditional Rules block
  // below (design D1). `formatKnowledgeChunks` stays a pure formatter and the
  // "Relevant knowledge:" line stays its first line (design D2, D3).
  const knowledgeSection =
    knowledgeContext && knowledgeContext.length
      ? `${formatKnowledgeChunks(knowledgeContext)}\n\n${KNOWLEDGE_DIRECTIVE}\n\n`
      : "";

  const systemContent = `${systemPrompt}

${knowledgeSection}Rules:
${languageInstruction}
- Keep replies concise and conversational.
- Use Markdown only when it helps clarity.`;

  const historyMessages = history.map((m) => ({
    role: m.role === "agent" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  // Some cloud endpoints (e.g. kimi-k2.6:cloud via Ollama proxy) require the
  // final message to be from the user role, otherwise they return empty content.
  // Only append the prompt when history is empty or ends with an agent message;
  // if the user just spoke, their message is already the final user message.
  const lastRole = historyMessages[historyMessages.length - 1]?.role;
  if (!lastRole || lastRole === "assistant") {
    historyMessages.push({ role: "user", content: "Please respond." });
  }

  const messages: OllamaMessage[] = [
    { role: "system", content: systemContent },
    ...historyMessages,
  ];
  return messages;
}

/**
 * Return a history slice suitable for the LLM context, capped at a soft
 * number of user+agent exchanges. Oldest pairs are dropped first.
 */
export function trimVoiceAgentHistory(
  history: VoiceAgentMessage[],
  maxExchanges: number
): VoiceAgentMessage[] {
  if (maxExchanges <= 0 || history.length === 0) return history;
  // Each exchange is one agent + one user message. We keep the most recent
  // `maxExchanges` agent messages plus their corresponding user messages.
  const agentIndices: number[] = [];
  history.forEach((m, idx) => {
    if (m.role === "agent") agentIndices.push(idx);
  });
  if (agentIndices.length <= maxExchanges) return history;
  const keepFromIndex = agentIndices[agentIndices.length - maxExchanges];
  return history.slice(keepFromIndex);
}

export async function buildPrompt(
  session: PromptSession,
  messages: PromptMessage[]
): Promise<OllamaMessage[]> {
  const coverage = await getRequirementCoverage(session.id, session.positionId);

  const coveredTopics = coverage.covered.map((c) => c.content);
  const remainingTopics = coverage.remaining.map((r) => r.content);

  const systemPrompt = buildSystemPrompt(session.language);
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

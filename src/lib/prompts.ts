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

export async function buildPrompt(
  session: PromptSession,
  messages: PromptMessage[]
): Promise<OllamaMessage[]> {
  const coverage = await getRequirementCoverage(session.id, session.positionId);

  const coveredTopics = coverage.covered.map((c) => c.content);
  const remainingTopics = coverage.remaining.map((r) => r.content);

  const cvSection = session.candidate.cv
    ? `\nCandidate CV summary:\n${session.candidate.cv.substring(0, 800)}`
    : "";

  const jobDescSection = session.position.jobDescription
    ? `\nJob Description:\n${session.position.jobDescription.substring(0, 1200)}`
    : "";

  const contextPrompt = `You are an experienced technical interviewer conducting a structured interview.

Position: ${session.position.title} (${session.position.level})${jobDescSection}
Requirements: ${session.position.requirements.join(", ")}

Candidate: ${session.candidate.name}
Skills: ${session.candidate.skills.join(", ")}
Experience: ${session.candidate.experienceYears ?? "N/A"} years${cvSection}

Topics already covered: ${coveredTopics.join(", ") || "None yet"}
Remaining topics to explore: ${remainingTopics.join(", ") || "None — feel free to dig deeper on covered topics or ask behavioral questions"}

Generate the next interview question. One concise question only, no preamble, no explanation. Keep it relevant to the position requirements and the candidate's background. Use Markdown formatting. If you include code examples, specify the language after the opening backticks (e.g., \`\`\`python, \`\`\`go).`;

  const ollamaMessages: OllamaMessage[] = [
    { role: "user", content: contextPrompt },
  ];

  // Only include last 3 messages to keep context short for slow cloud models
  const recentMessages = messages.slice(-3);
  for (const msg of recentMessages) {
    ollamaMessages.push({
      role: msg.role === "interviewer" ? "assistant" : "user",
      content: msg.content,
    });
  }

  return ollamaMessages;
}

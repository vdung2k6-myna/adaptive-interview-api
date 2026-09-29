import { OllamaError } from "./errors";
import config from "./config";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaGenerateOptions {
  model?: string;
  messages: OllamaMessage[];
  temperature?: number;
  repeat_penalty?: number;
}

export interface GenerateStreamResult {
  stream: ReadableStream<string>;
  getFullText: () => string;
}

/** The counts Ollama reports on a finished chat call. Every field is optional:
 * these are only ever logged, never required. */
interface TokenCounts {
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
}

const TOKEN_COUNT_KEYS = [
  "prompt_eval_count",
  "prompt_eval_cached_count",
  "eval_count",
] as const;

/**
 * Report what a chat call cost, from the counts the service sent with it.
 *
 * This is the only exact measurement of a turn's prompt size available from
 * inside the system — the character budget in `prompts.ts` is a prediction made
 * before the call, and this is what it actually came to. `prompt_eval_cached_count`
 * is the one to watch when tuning: a repeated system prompt plus a shared history
 * prefix is exactly what prefix caching earns, so it reports what a turn cost
 * rather than what it nominally contained.
 *
 * Fields the service did not send are left out rather than logged as
 * `undefined`, and a response carrying none of them logs nothing at all — an
 * absent count is not a zero. Returns whether anything was logged, so a caller
 * reading a stream can report the first chunk that carries counts and no later one.
 */
function logTokenCounts(model: string, counts: TokenCounts): boolean {
  const reported = TOKEN_COUNT_KEYS.filter((key) => typeof counts[key] === "number").map(
    (key) => `${key}=${counts[key]}`
  );
  if (!reported.length) return false;

  console.log(`[ollama] chat ${model} ${reported.join(" ")}`);
  return true;
}

export async function embedText(text: string): Promise<number[]> {
  const baseUrl = process.env.OLLAMA_BASE_URL || config.ollama.baseUrl;
  const model = process.env.OLLAMA_EMBED_MODEL || config.ollama.embedModel;
  const url = `${baseUrl}/api/embeddings`;

  const controller = new AbortController();
  const timeoutMs = config.ollama.embedTimeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.text().catch(() => "Unknown error");
      throw new OllamaError(
        `Ollama embedding returned ${res.status}: ${body}`,
        res.status
      );
    }

    const raw = await res.text();
    let data: { embedding?: number[] };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new OllamaError("Ollama embedding returned invalid JSON.", 502);
    }

    const embedding = data.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new OllamaError("Ollama embedding response contained no vector.", 502);
    }

    return embedding;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof OllamaError) {
      throw err;
    }

    if (err instanceof Error && err.name === "AbortError") {
      throw new OllamaError(`Ollama embedding timed out after ${config.ollama.embedTimeoutMs / 1000}s.`, 504);
    }

    throw new OllamaError(
      err instanceof Error ? err.message : "Unknown Ollama embedding error",
      500
    );
  }
}

export async function generateChatResponse(
  options: OllamaGenerateOptions
): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL || config.ollama.baseUrl;
  const model = options.model || process.env.OLLAMA_MODEL || config.ollama.chatModel;
  const url = `${baseUrl}/api/chat`;

  const controller = new AbortController();
  const timeoutMs = config.ollama.chatTimeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestBody = JSON.stringify({
      model,
      messages: options.messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        repeat_penalty: options.repeat_penalty ?? 1.1,
      },
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.text().catch(() => "Unknown error");
      throw new OllamaError(
        `Ollama returned ${res.status}: ${body}`,
        res.status
      );
    }

    const raw = await res.text();
    let data: { message?: { content?: string } } & TokenCounts;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new OllamaError("Ollama returned invalid JSON.", 502);
    }

    // Logged before the content guard: a response that arrived without content
    // still evaluated the prompt, and that cost is worth seeing next to the error.
    logTokenCounts(model, data);

    const content = data.message?.content?.trim();

    if (!content) {
      throw new OllamaError("Ollama response contained no content.", 502);
    }

    return content;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof OllamaError) {
      throw err;
    }

    if (err instanceof Error && err.name === "AbortError") {
      throw new OllamaError(`Ollama request timed out after ${config.ollama.chatTimeoutMs / 1000}s.`, 504);
    }

    throw new OllamaError(
      err instanceof Error ? err.message : "Unknown Ollama error",
      500
    );
  }
}

export function generateChatResponseStream(
  options: OllamaGenerateOptions
): GenerateStreamResult {
  const baseUrl = process.env.OLLAMA_BASE_URL || config.ollama.baseUrl;
  const model = options.model || process.env.OLLAMA_MODEL || config.ollama.chatModel;
  const url = `${baseUrl}/api/chat`;

  const controller = new AbortController();
  const timeoutMs = config.ollama.chatTimeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let fullText = "";

  const stream = new ReadableStream<string>({
    async start(streamController) {
      try {
        const requestBody = JSON.stringify({
          model,
          messages: options.messages,
          stream: true,
          options: {
            temperature: options.temperature ?? 0.7,
            repeat_penalty: options.repeat_penalty ?? 1.1,
          },
        });

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const body = await res.text().catch(() => "Unknown error");
          streamController.error(
            new OllamaError(
              `Ollama returned ${res.status}: ${body}`,
              res.status
            )
          );
          return;
        }

        if (!res.body) {
          streamController.error(
            new OllamaError("Ollama returned empty body.", 502)
          );
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // The counts ride the final chunk, and one call reports them once — so the
        // first chunk that carries them is logged and no later one is.
        let countsLogged = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line) as {
                message?: { content?: string };
                done?: boolean;
              } & TokenCounts;
              const content = data.message?.content || "";
              if (content) {
                fullText += content;
                streamController.enqueue(content);
              }
              if (!countsLogged && logTokenCounts(model, data)) countsLogged = true;
              if (data.done) {
                streamController.close();
                return;
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer) as {
              message?: { content?: string };
              done?: boolean;
            } & TokenCounts;
            const content = data.message?.content || "";
            if (content) {
              fullText += content;
              streamController.enqueue(content);
            }
            if (!countsLogged && logTokenCounts(model, data)) countsLogged = true;
          } catch {
            // Skip malformed JSON
          }
        }

        streamController.close();
      } catch (err) {
        clearTimeout(timeoutId);

        if (err instanceof Error && err.name === "AbortError") {
          streamController.error(
            new OllamaError(`Ollama request timed out after ${config.ollama.chatTimeoutMs / 1000}s.`, 504)
          );
          return;
        }

        streamController.error(
          err instanceof OllamaError
            ? err
            : new OllamaError(
                err instanceof Error ? err.message : "Unknown Ollama error",
                500
              )
        );
      }
    },
    cancel() {
      clearTimeout(timeoutId);
      controller.abort();
    },
  });

  return {
    stream,
    getFullText: () => fullText,
  };
}

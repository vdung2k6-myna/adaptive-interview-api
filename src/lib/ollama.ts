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
}

export interface GenerateStreamResult {
  stream: ReadableStream<string>;
  getFullText: () => string;
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
    let data: { message?: { content?: string } };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new OllamaError("Ollama returned invalid JSON.", 502);
    }
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
              };
              const content = data.message?.content || "";
              if (content) {
                fullText += content;
                streamController.enqueue(content);
              }
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
            };
            const content = data.message?.content || "";
            if (content) {
              fullText += content;
              streamController.enqueue(content);
            }
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

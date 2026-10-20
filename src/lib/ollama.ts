import { OllamaError } from "./errors";
import config from "./config";
import { createSemaphore, type ReleaseSlot } from "./semaphore";

/**
 * Every model request this process makes shares one account, so it shares one
 * bound. Turns, the agent's tool rounds and embeddings all pass through here;
 * counting them separately would let each caller be polite on its own while the
 * process as a whole went over the ceiling.
 */
const modelSlots = createSemaphore(config.ollama.maxConcurrentRequests);

/** A service at its limit answers these; they are the only statuses worth waiting on. */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Backoff starts here and is capped here; the whole sequence is bounded by the
 *  retry deadline, so this cap only stops the jitter from spending it in one go. */
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4_000;

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/** Full jitter: a burst of turns refused together must not retry together. */
function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  );
  return Math.floor(Math.random() * ceiling);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A response with the slot it holds, which the caller gives back when it is done. */
interface ModelCall {
  res: Response;
  release: ReleaseSlot;
}

/**
 * Make a model request under the process's concurrency bound, retrying a refusal
 * of the initial response.
 *
 * A retry is only ever made before content has started: a refusal arrives with
 * no body to keep, so nothing is lost by asking again, while a failure once
 * tokens have streamed would be answered by speaking the reply twice. The slot
 * is given back while waiting, because a caller backing off is not using the
 * service and must not stop another turn from using it.
 *
 * When the deadline leaves no room for another attempt, the refusal is returned
 * as it is — the caller then reports what the service said, rather than a
 * timeout of our own invention.
 */
async function requestModel(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<ModelCall> {
  const deadline = Date.now() + config.ollama.retryDeadlineMs;
  const attempts = Math.max(1, config.ollama.retries + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const release = await modelSlots.acquire(signal);

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      release();
      throw err;
    }

    if (!RETRYABLE_STATUSES.has(res.status) || attempt === attempts) {
      return { res, release };
    }

    const wait = retryDelayMs(attempt);
    if (Date.now() + wait >= deadline) {
      return { res, release };
    }

    // Nothing in a refusal's body is kept, and the slot is not ours to hold
    // while we sleep.
    await res.text().catch(() => undefined);
    release();
    await pause(wait, signal);
  }

  throw new Error("unreachable: the retry loop always returns or throws");
}

/** One call a model asked for, as it reported it. `arguments` arrives already parsed — Ollama
 *  does that before the chunk reaches us — and is handed to the gadget as it stands. */
export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * One message of the conversation the model is asked with.
 *
 * The first three roles are the turn's own. The last two exist for what a turn has with a
 * gadget: the call the model asked for, then what the call did. A result names the tool it
 * belongs to, which is how Ollama pairs the two where OpenAI carries an id.
 */
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** The calls a model's own message asked for, echoed back in the next round. */
  tool_calls?: OllamaToolCall[];
  /** The tool a `tool` message is the result of, by the name the model called. */
  tool_name?: string;
}

/**
 * One tool, in the shape a model is given one.
 *
 * Ollama takes OpenAI's dialect: the function is named and described at the top and its
 * JSON Schema hangs under `parameters`. A gadget states the same three things under
 * `inputSchema` (see `parseGadgetTools`), so what happens between the two is a rename.
 */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

/**
 * A gadget's own report of what it can be asked to do, as the bridge carries it.
 *
 * `inputSchema` is the firmware's own JSON Schema, sent unedited. `args` is the bridge's
 * reading of that schema and never travels, so it is not read here either.
 */
export interface GadgetToolReport {
  name: string;
  description: string;
  inputSchema?: unknown;
}

/** A schema for a tool that declared none. A function whose `parameters` is absent is one
 *  Ollama will not take, and "it takes nothing" is what a tool that stated nothing stated. */
const NO_PARAMETERS = { type: "object", properties: {} } as const;

/**
 * The gadget's report, as the model is given it — the rename described on `OllamaTool`, and
 * nothing more.
 *
 * Anything that is not a report is dropped rather than repaired: a tool with no name is not a
 * tool, and a model given one would call something nothing can answer. An empty result is the
 * ordinary case of a gadget that reported none, which is what leaves a turn asked without
 * tools at all.
 */
export function parseGadgetTools(raw: string | undefined): OllamaTool[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[Ollama] the tools field was not JSON; this turn is asked with no tools");
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const tools: OllamaTool[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, description, inputSchema } = entry as GadgetToolReport;
    if (typeof name !== "string" || name === "") continue;
    tools.push({
      type: "function",
      function: {
        name,
        description: typeof description === "string" ? description : "",
        parameters: inputSchema ?? NO_PARAMETERS,
      },
    });
  }
  return tools;
}

export interface OllamaGenerateOptions {
  model?: string;
  messages: OllamaMessage[];
  temperature?: number;
  repeat_penalty?: number;
  /** What the model may ask to be done. Omitted — not empty — when there is nothing it may
   *  call, so a turn with no tools is the request it was before any of this existed. */
  tools?: OllamaTool[];
}

export interface GenerateStreamResult {
  stream: ReadableStream<string>;
  getFullText: () => string;
  /**
   * What the model asked to be done, in the order it asked. Empty for a turn that answered in
   * words — which is every turn that was not given tools, and every turn a browser client
   * takes.
   *
   * Read after the stream ends rather than during it: a call arrives as a whole message with
   * no content beside it, so there is nothing to stream while it is being made, and the turn
   * has nothing to say until it knows whether the call it is looking at succeeded.
   */
  getToolCalls: () => OllamaToolCall[];
}

/**
 * The calls a chunk carried, if any.
 *
 * `arguments` is an object in Ollama's own dialect and a JSON *string* in the OpenAI-compatible
 * one, so both are read: a bridge that got this wrong would hand the gadget `"[object Object]"`
 * or a string where its schema expects an integer. Anything without a usable name is dropped —
 * a call to no tool is not a call.
 */
function readToolCalls(message: { tool_calls?: unknown } | undefined): OllamaToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];

  const calls: OllamaToolCall[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const fn = (entry as { function?: unknown }).function;
    if (typeof fn !== "object" || fn === null) continue;
    const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string" || name === "") continue;

    let parsed: Record<string, unknown> = {};
    if (typeof args === "string") {
      try {
        const decoded: unknown = JSON.parse(args);
        if (typeof decoded === "object" && decoded !== null) parsed = decoded as Record<string, unknown>;
      } catch {
        // A call whose arguments could not be read is still a call: it goes with none, and the
        // gadget's own schema is what refuses it.
      }
    } else if (typeof args === "object" && args !== null) {
      parsed = args as Record<string, unknown>;
    }
    calls.push({ function: { name, arguments: parsed } });
  }
  return calls;
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
    const { res, release } = await requestModel(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      },
      controller.signal
    );

    try {
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
    } finally {
      release();
    }
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

    const { res, release } = await requestModel(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      },
      controller.signal
    );

    try {
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
    } finally {
      release();
    }
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
  // What the model asked to be done, in the order it asked — see `getToolCalls`.
  const toolCalls: OllamaToolCall[] = [];
  /**
   * The slot this stream holds while the model is generating.
   *
   * Declared outside `start` because `cancel` has to be able to give it back: a
   * turn the client walked away from must not keep the process at its bound for
   * the length of a reply nobody is reading.
   */
  let releaseModelSlot: ReleaseSlot | null = null;

  const stream = new ReadableStream<string>({
    async start(streamController) {
      try {
        const requestBody = JSON.stringify({
          model,
          messages: options.messages,
          stream: true,
          // Omitted rather than sent empty. An empty list is a claim that the model may call
          // nothing; silence is a turn that was asked without tools, which is every turn a
          // browser client takes and every turn this service took before any of this.
          ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
          options: {
            temperature: options.temperature ?? 0.7,
            repeat_penalty: options.repeat_penalty ?? 1.1,
          },
        });

        const { res, release } = await requestModel(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          },
          controller.signal
        );
        releaseModelSlot = release;

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
                message?: { content?: string; tool_calls?: unknown };
                done?: boolean;
              } & TokenCounts;
              const content = data.message?.content || "";
              for (const call of readToolCalls(data.message)) toolCalls.push(call);
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
              message?: { content?: string; tool_calls?: unknown };
              done?: boolean;
            } & TokenCounts;
            const content = data.message?.content || "";
            for (const call of readToolCalls(data.message)) toolCalls.push(call);
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
      } finally {
        // The slot is held for the whole stream, not just the response headers:
        // what the account counts is requests in flight, which is exactly this
        // generation.
        releaseModelSlot?.();
        releaseModelSlot = null;
      }
    },
    cancel() {
      clearTimeout(timeoutId);
      controller.abort();
      releaseModelSlot?.();
      releaseModelSlot = null;
    },
  });

  return {
    stream,
    getFullText: () => fullText,
    getToolCalls: () => toolCalls,
  };
}

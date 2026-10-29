import { ModelProviderError, OllamaError } from "./errors";
import config from "./config";
import { createSemaphore, type ReleaseSlot } from "./semaphore";

/**
 * Every model request this process makes shares one account, so it shares one
 * bound. Turns, the agent's tool rounds and embeddings all pass through here;
 * counting them separately would let each caller be polite on its own while the
 * process as a whole went over the ceiling.
 */
const modelSlots = createSemaphore(config.ollama.maxConcurrentRequests);

/** Backoff starts here and is capped here; the whole sequence is bounded by the
 *  retry deadline, so this cap only stops the jitter from spending it in one go. */
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4_000;

/** The most jitter added to a provider-directed wait, so turns refused together do
 *  not retry together. The provider's own duration remains the minimum. */
const RETRY_AFTER_JITTER_MS = 250;

/**
 * The wait a response asks for, in milliseconds. `Retry-After` is delta-seconds or
 * an HTTP date; an absent, malformed or already-past value is `undefined`.
 */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after")?.trim();
  if (header === undefined || header === "") return undefined;

  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const wait = at - Date.now();
  return wait > 0 ? wait : undefined;
}

/**
 * A refusal worth asking again: 429 and 503, and a 413 that carries `Retry-After`.
 * A 413 without one names a request over the provider's ceiling, which waiting
 * cannot fix.
 */
function isRetryable(res: Response): boolean {
  if (res.status === 429 || res.status === 503) return true;
  return res.status === 413 && retryAfterMs(res) !== undefined;
}

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
 *
 * A provider that names a wait in `Retry-After` is honoured up to
 * `retryAfterMaxMs`, even when that is longer than the deadline above: the
 * deadline budgets this runtime's own backoff, while the header is the provider
 * saying when its per-minute budget will recover. The attempt count still
 * applies, and the turn's abort signal ends the wait.
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

    if (!isRetryable(res) || attempt === attempts) {
      return { res, release };
    }

    const after = retryAfterMs(res);
    let wait: number;
    if (after !== undefined) {
      if (after > config.ollama.retryAfterMaxMs) {
        return { res, release };
      }
      const jitter = Math.min(
        RETRY_AFTER_JITTER_MS,
        Math.max(0, config.ollama.retryAfterMaxMs - after)
      );
      wait = Math.min(
        after + Math.floor(Math.random() * (jitter + 1)),
        config.ollama.retryAfterMaxMs
      );
    } else {
      wait = retryDelayMs(attempt);
      if (Date.now() + wait >= deadline) {
        return { res, release };
      }
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
 *  does that before the chunk reaches us — and is handed to the gadget as it stands. The `id`
 *  is the provider's, when it supplies one; the OpenAI dialect needs it to pair a result. */
export interface OllamaToolCall {
  id?: string;
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
  /** The call a `tool` message is the result of, in the OpenAI dialect. */
  tool_call_id?: string;
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

/**
 * The account's own OpenAI-compatible endpoint. Present for a turn whose agent
 * names a profile; absent for every other turn, which is the request this
 * service made before any of this existed.
 */
export interface LlmTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** null means the provider's own default; the field is then not sent. */
  temperature: number | null;
}

export interface OllamaGenerateOptions {
  model?: string;
  messages: OllamaMessage[];
  temperature?: number;
  repeat_penalty?: number;
  /** What the model may ask to be done. Omitted — not empty — when there is nothing it may
   *  call, so a turn with no tools is the request it was before any of this existed. */
  tools?: OllamaTool[];
  /** The account's model. Absent selects this deployment's own Ollama. */
  llm?: LlmTarget;
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
    const { id, function: fn } = entry as { id?: unknown; function?: unknown };
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
    calls.push({
      ...(typeof id === "string" && id !== "" ? { id } : {}),
      function: { name, arguments: parsed },
    });
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

/**
 * A message in the native Ollama dialect. The internal shape now carries the OpenAI call id
 * and the tool-result reference; both are dropped here, so `/api/chat` sees the body it saw
 * before an account could name an OpenAI-compatible provider.
 */
function nativeMessages(messages: OllamaMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls.map((call) => ({
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        ...(message.tool_name === undefined ? {} : { tool_name: message.tool_name }),
      };
    }
    return message;
  });
}

export async function generateChatResponse(
  options: OllamaGenerateOptions
): Promise<string> {
  if (options.llm !== undefined) return generateOpenAiResponse(options, options.llm);
  const baseUrl = process.env.OLLAMA_BASE_URL || config.ollama.baseUrl;
  const model = options.model || process.env.OLLAMA_MODEL || config.ollama.chatModel;
  const url = `${baseUrl}/api/chat`;

  const controller = new AbortController();
  const timeoutMs = config.ollama.chatTimeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestBody = JSON.stringify({
      model,
      messages: nativeMessages(options.messages),
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
  if (options.llm !== undefined) return generateOpenAiStream(options, options.llm);
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
          messages: nativeMessages(options.messages),
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

/**
 * The account's own model, over the OpenAI-compatible protocol.
 *
 * One adapter covers OpenAI, Groq, OpenRouter, vLLM, LM Studio and Ollama's own
 * `/v1`: they agree on `/chat/completions`, a bearer key, SSE deltas and the tool
 * shape this service already sends. What it deliberately does not do is fall
 * back — a provider that refuses is the turn's failure, never another model's
 * answer, because a silent substitution would spend this deployment's money to
 * hide the account's problem.
 */

function openAiChatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function openAiHeaders(llm: LlmTarget): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` };
}

/**
 * A message in the OpenAI dialect. The internal shape is Ollama's — arguments are objects,
 * and a tool result names its tool. This projection is the other dialect: arguments are a
 * JSON string, every call has an id and a type, and a result names the call it answers.
 */
function openAiMessages(messages: OllamaMessage[]): unknown[] {
  return messages.map((message, messageIndex) => {
    if (
      message.role === "assistant" &&
      message.tool_calls !== undefined &&
      message.tool_calls.length > 0
    ) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls.map((call, callIndex) => ({
          id: call.id ?? `call_${messageIndex}_${callIndex}`,
          type: "function",
          function: {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments),
          },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id ?? message.tool_name ?? "",
        content: message.content,
      };
    }
    return message;
  });
}

function openAiBody(options: OllamaGenerateOptions, llm: LlmTarget, stream: boolean): string {
  return JSON.stringify({
    model: llm.model,
    messages: openAiMessages(options.messages),
    stream,
    // Omitted rather than sent empty, exactly as the Ollama body does: a turn with
    // no tools is one the model answers without them.
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    // The profile's temperature, or the provider's own default. The turn's 0.7 is
    // a property of this deployment's model, not of the account's.
    ...(llm.temperature === null ? {} : { temperature: llm.temperature }),
  });
}

function providerError(url: string, status: number, body: string): ModelProviderError {
  const detail = body.trim().slice(0, 200);
  return new ModelProviderError(
    `the model provider at ${url} returned ${status}${detail === "" ? "" : `: ${detail}`}`,
    status
  );
}

async function generateOpenAiResponse(
  options: OllamaGenerateOptions,
  llm: LlmTarget
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.ollama.chatTimeoutMs);

  try {
    const { res, release } = await requestModel(
      openAiChatUrl(llm.baseUrl),
      { method: "POST", headers: openAiHeaders(llm), body: openAiBody(options, llm, false) },
      controller.signal
    );

    try {
      clearTimeout(timeoutId);
      if (!res.ok) throw providerError(openAiChatUrl(llm.baseUrl), res.status, await res.text().catch(() => ""));

      const raw = await res.text();
      let data: {
        choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new ModelProviderError("the model provider returned invalid JSON", 502);
      }

      logTokenCounts(llm.model, {
        prompt_eval_count: data.usage?.prompt_tokens,
        eval_count: data.usage?.completion_tokens,
      });

      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new ModelProviderError("the model provider's answer contained no content", 502);
      return content;
    } finally {
      release();
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof OllamaError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ModelProviderError(
        `the model provider timed out after ${config.ollama.chatTimeoutMs / 1000}s`,
        504
      );
    }
    throw new ModelProviderError(
      `the model provider at ${openAiChatUrl(llm.baseUrl)} could not be reached: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}

function generateOpenAiStream(
  options: OllamaGenerateOptions,
  llm: LlmTarget
): GenerateStreamResult {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.ollama.chatTimeoutMs);

  let fullText = "";
  const toolCalls: OllamaToolCall[] = [];
  let releaseModelSlot: ReleaseSlot | null = null;

  const stream = new ReadableStream<string>({
    async start(streamController) {
      try {
        const { res, release } = await requestModel(
          openAiChatUrl(llm.baseUrl),
          { method: "POST", headers: openAiHeaders(llm), body: openAiBody(options, llm, true) },
          controller.signal
        );
        releaseModelSlot = release;
        clearTimeout(timeoutId);

        if (!res.ok) {
          streamController.error(providerError(openAiChatUrl(llm.baseUrl), res.status, await res.text().catch(() => "")));
          return;
        }
        if (!res.body) {
          streamController.error(new ModelProviderError("the model provider returned an empty body", 502));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        // Tool calls arrive as deltas too: the name and the arguments of one call
        // are spread across chunks, so they are gathered by index and read once the
        // stream ends.
        const pending = new Map<number, { id?: string; name: string; arguments: string }>();
        let buffer = "";

        const consume = (payload: string): boolean => {
          if (payload === "[DONE]") return true;
          let event: {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            event = JSON.parse(payload);
          } catch {
            return false;
          }

          const delta = event.choices?.[0]?.delta;
          const content = delta?.content ?? "";
          if (content !== "") {
            fullText += content;
            streamController.enqueue(content);
          }
          for (const call of delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            const slot = pending.get(index) ?? { name: "", arguments: "" };
            if (typeof call.id === "string" && call.id !== "") slot.id = call.id;
            if (typeof call.function?.name === "string") slot.name += call.function.name;
            if (typeof call.function?.arguments === "string") slot.arguments += call.function.arguments;
            pending.set(index, slot);
          }
          if (event.usage !== undefined) {
            logTokenCounts(llm.model, {
              prompt_eval_count: event.usage.prompt_tokens,
              eval_count: event.usage.completion_tokens,
            });
          }
          return false;
        };

        let done = false;
        while (!done) {
          const read = await reader.read();
          if (read.done) break;
          buffer += decoder.decode(read.value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            if (consume(trimmed.slice(5).trim())) {
              done = true;
              break;
            }
          }
        }

        const tail = buffer.trim();
        if (!done && tail.startsWith("data:")) consume(tail.slice(5).trim());

        if (pending.size > 0) {
          for (const call of readToolCalls({
            tool_calls: [...pending.values()].map((entry) => ({
              ...(entry.id === undefined ? {} : { id: entry.id }),
              function: entry,
            })),
          })) {
            toolCalls.push(call);
          }
        }

        streamController.close();
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
          streamController.error(
            new ModelProviderError(
              `the model provider timed out after ${config.ollama.chatTimeoutMs / 1000}s`,
              504
            )
          );
          return;
        }
        streamController.error(
          err instanceof OllamaError
            ? err
            : new ModelProviderError(
                `the model provider at ${openAiChatUrl(llm.baseUrl)} could not be reached: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
                502
              )
        );
      } finally {
        // The slot is held for the whole stream, not just for the headers — and it
        // must come back when the stream ends, or every provider turn would take
        // one with it and the process would stall once it had served twelve.
        releaseModelSlot?.();
        releaseModelSlot = null;
      }
    },

    cancel() {
      controller.abort();
      clearTimeout(timeoutId);
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

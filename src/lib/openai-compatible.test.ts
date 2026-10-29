import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { OllamaError } from "./errors";
import {
  generateChatResponse,
  generateChatResponseStream,
  type LlmTarget,
  type OllamaMessage,
} from "./ollama";

/**
 * The account's own model, over the OpenAI-compatible protocol.
 *
 * The stub is a real HTTP server rather than a stubbed `fetch`: what is under
 * test is the parser's handling of a streamed body and the shape of the request
 * that leaves this process — the model, the temperature, and the bearer key that
 * must be there and must not be anywhere else.
 */

interface Seen {
  path: string;
  authorization: string | undefined;
  body: string;
}

describe("an OpenAI-compatible turn", () => {
  let server: Server;
  let url = "";
  let seen: Seen[] = [];
  /** What the stub answers: a status, a content type, a body, and optional headers. */
  let answer: {
    status: number;
    contentType: string;
    body: string;
    headers?: Record<string, string>;
  } = {
    status: 200,
    contentType: "text/event-stream",
    body: "",
  };
  /** Answers for successive requests, when a test needs a refusal followed by a success. */
  let queue: Array<{
    status: number;
    contentType: string;
    body: string;
    headers?: Record<string, string>;
  }> = [];

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const next = queue.shift() ?? answer;
        res.writeHead(next.status, { "Content-Type": next.contentType, ...(next.headers ?? {}) });
        res.end(next.body);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  function reset(): void {
    seen = [];
    queue = [];
  }

  function llm(overrides: Partial<LlmTarget> = {}): LlmTarget {
    return {
      baseUrl: url,
      apiKey: "sk-live-abc123",
      model: "gpt-4o-mini",
      temperature: null,
      ...overrides,
    };
  }

  const messages = [{ role: "user" as const, content: "hello" }];

  it("streams the deltas and asks the model the profile names", async () => {
    reset();
    answer = {
      status: 200,
      contentType: "text/event-stream",
      body:
        'data: {"choices":[{"delta":{"content":"Xin "}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"chào"}}]}\n\n' +
        "data: [DONE]\n\n",
    };

    const result = generateChatResponseStream({ messages, llm: llm({ temperature: 0.4 }) });
    const reader = result.stream.getReader();
    let text = "";
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      text += read.value;
    }

    assert.equal(text, "Xin chào");
    assert.equal(result.getFullText(), "Xin chào");
    assert.equal(seen[0]?.path, "/v1/chat/completions");
    assert.equal(seen[0]?.authorization, "Bearer sk-live-abc123");
    const body = JSON.parse(seen[0]!.body) as { model: string; temperature: number; stream: boolean };
    assert.equal(body.model, "gpt-4o-mini");
    assert.equal(body.temperature, 0.4);
    assert.equal(body.stream, true);
  });

  it("omits the temperature when the profile names none", async () => {
    reset();
    answer = { status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n" };

    const result = generateChatResponseStream({ messages, llm: llm() });
    await result.stream.getReader().read();

    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    assert.equal("temperature" in body, false);
  });

  it("gathers a tool call spread across deltas", async () => {
    reset();
    answer = {
      status: 200,
      contentType: "text/event-stream",
      body:
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bridge.play_music","arguments":"{\\"q\\""}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"bolero\\"}"}}]}}]}\n\n' +
        "data: [DONE]\n\n",
    };

    const result = generateChatResponseStream({ messages, llm: llm() });
    await result.stream.getReader().read();

    assert.deepEqual(result.getToolCalls(), [
      { function: { name: "bridge.play_music", arguments: { q: "bolero" } } },
    ]);
  });

  it("keeps the provider's call id through a streamed call", async () => {
    reset();
    answer = {
      status: 200,
      contentType: "text/event-stream",
      body:
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"bridge.play_music","arguments":"{\\"q\\":\\"bolero\\"}"}}]}}]}\n\n' +
        "data: [DONE]\n\n",
    };

    const result = generateChatResponseStream({ messages, llm: llm() });
    await result.stream.getReader().read();

    assert.deepEqual(result.getToolCalls(), [
      { id: "call_abc", function: { name: "bridge.play_music", arguments: { q: "bolero" } } },
    ]);
  });

  it("replays a tool call and its result in the OpenAI dialect", async () => {
    reset();
    answer = { status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n" };
    const replay: OllamaMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_abc", function: { name: "bridge.play_music", arguments: { q: "bolero" } } },
        ],
      },
      {
        role: "tool",
        content: "playing bolero",
        tool_name: "bridge.play_music",
        tool_call_id: "call_abc",
      },
    ];

    const result = generateChatResponseStream({ messages: replay, llm: llm() });
    await result.stream.getReader().read();

    const body = JSON.parse(seen[0]!.body) as { messages: unknown };
    assert.deepEqual(body.messages, [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "bridge.play_music", arguments: '{"q":"bolero"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "playing bolero" },
    ]);
  });

  it("names a replayed call by its position when the provider supplied no id", async () => {
    reset();
    answer = { status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n" };
    const replay: OllamaMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "bridge.play_music", arguments: { q: "bolero" } } }],
      },
    ];

    const result = generateChatResponseStream({ messages: replay, llm: llm() });
    await result.stream.getReader().read();

    const body = JSON.parse(seen[0]!.body) as {
      messages: Array<{ tool_calls?: Array<{ id?: string }> }>;
    };
    assert.equal(body.messages[0]?.tool_calls?.[0]?.id, "call_0_0");
  });

  it("reports the provider's refusal rather than answering with another model", async () => {
    reset();
    answer = { status: 401, contentType: "application/json", body: '{"error":"invalid api key"}' };

    const result = generateChatResponseStream({ messages, llm: llm() });
    await assert.rejects(
      () => result.stream.getReader().read(),
      (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /the model provider at .* returned 401/);
        return true;
      }
    );
  });

  it("waits for Retry-After and retries a 413 that names one", async () => {
    reset();
    queue = [
      {
        status: 413,
        contentType: "application/json",
        body: '{"error":"Request too large"}',
        headers: { "retry-after": "1" },
      },
      {
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      },
    ];

    const started = Date.now();
    const result = generateChatResponseStream({ messages, llm: llm() });
    const reader = result.stream.getReader();
    let text = "";
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      text += read.value;
    }

    assert.equal(text, "ok");
    assert.equal(seen.length, 2, "the 413 is retried after the wait");
    assert.ok(Date.now() - started >= 900, "the wait is at least the provider's second");
  });

  it("reports a 413 without Retry-After instead of retrying it", async () => {
    reset();
    answer = {
      status: 413,
      contentType: "application/json",
      body: '{"error":"Request too large"}',
    };

    const result = generateChatResponseStream({ messages, llm: llm() });
    await assert.rejects(
      () => result.stream.getReader().read(),
      (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal(error.statusCode, 413);
        assert.match(error.message, /returned 413/);
        assert.equal(error.message.includes("sk-live-abc123"), false, "the key is not in the error");
        return true;
      }
    );
    assert.equal(seen.length, 1, "a 413 with no wait is not retried");
  });

  it("does not wait on a Retry-After longer than the cap", async () => {
    reset();
    answer = {
      status: 413,
      contentType: "application/json",
      body: '{"error":"Request too large"}',
      headers: { "retry-after": "99" },
    };

    const started = Date.now();
    const result = generateChatResponseStream({ messages, llm: llm() });
    await assert.rejects(
      () => result.stream.getReader().read(),
      (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal(error.statusCode, 413);
        return true;
      }
    );
    assert.equal(seen.length, 1);
    assert.ok(Date.now() - started < 1000, "a wait over the cap is not waited on");
  });

  it("honours Retry-After on a 429 as well as on a 413", async () => {
    reset();
    queue = [
      {
        status: 429,
        contentType: "application/json",
        body: '{"error":"rate limited"}',
        headers: { "retry-after": "1" },
      },
      {
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      },
    ];

    const started = Date.now();
    const result = generateChatResponseStream({ messages, llm: llm() });
    const reader = result.stream.getReader();
    while (true) {
      const read = await reader.read();
      if (read.done) break;
    }

    assert.equal(seen.length, 2);
    assert.ok(Date.now() - started >= 900);
  });

  it("honours Retry-After given as an HTTP date", async () => {
    reset();
    const at = new Date(Date.now() + 2000).toUTCString();
    queue = [
      {
        status: 413,
        contentType: "application/json",
        body: '{"error":"Request too large"}',
        headers: { "retry-after": at },
      },
      {
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      },
    ];

    const started = Date.now();
    const result = generateChatResponseStream({ messages, llm: llm() });
    const reader = result.stream.getReader();
    while (true) {
      const read = await reader.read();
      if (read.done) break;
    }

    assert.equal(seen.length, 2);
    assert.ok(Date.now() - started >= 1000, "the date is not treated as a missing header");
  });

  it("does not retry a 413 whose Retry-After is invalid", async () => {
    reset();
    answer = {
      status: 413,
      contentType: "application/json",
      body: '{"error":"Request too large"}',
      headers: { "retry-after": "not-a-date" },
    };

    const result = generateChatResponseStream({ messages, llm: llm() });
    await assert.rejects(
      () => result.stream.getReader().read(),
      (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal(error.statusCode, 413);
        return true;
      }
    );
    assert.equal(seen.length, 1);
  });

  it("does not retry a 413 whose Retry-After is in the past", async () => {
    reset();
    answer = {
      status: 413,
      contentType: "application/json",
      body: '{"error":"Request too large"}',
      headers: { "retry-after": new Date(Date.now() - 1000).toUTCString() },
    };

    const result = generateChatResponseStream({ messages, llm: llm() });
    await assert.rejects(
      () => result.stream.getReader().read(),
      (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal(error.statusCode, 413);
        return true;
      }
    );
    assert.equal(seen.length, 1);
  });

  it("stops waiting when the turn is cancelled", async () => {
    reset();
    answer = {
      status: 413,
      contentType: "application/json",
      body: '{"error":"Request too large"}',
      headers: { "retry-after": "1" },
    };

    const result = generateChatResponseStream({ messages, llm: llm() });
    const reader = result.stream.getReader();
    const reading = reader.read().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await reader.cancel();
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(seen.length, 1, "the cancelled wait makes no second request");
  });

  it("returns its model slot when a stream ends, so later turns are not blocked", async () => {
    // The process' concurrency bound is twelve; a stream that kept its slot after
    // ending would stall every turn after the twelfth — the default model included.
    reset();
    answer = { status: 200, contentType: "text/event-stream", body: "data: [DONE]" };

    for (let index = 0; index < 15; index += 1) {
      const result = generateChatResponseStream({ messages, llm: llm() });
      const drained = (async () => {
        const reader = result.stream.getReader();
        while (true) {
          const read = await reader.read();
          if (read.done) return;
        }
      })();
      await Promise.race([
        drained,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error(`the ${index + 1}th stream never finished: its slot was not returned`)), 3000)
        ),
      ]);
    }
  });

  it("logs the model but never the key", async () => {
    // The key is the account's, not this deployment's: it may cross this process
    // and must never reach a line an operator or a log collector reads.
    reset();
    answer = {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    };

    const captured: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => captured.push(args.map((arg) => String(arg)).join(" "));
    try {
      console.log = capture;
      console.warn = capture;
      console.error = capture;
      await generateChatResponse({ messages, llm: llm() });
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }

    assert.equal(captured.join(" | ").includes("sk-live-abc123"), false);
    assert.ok(captured.join(" | ").includes("gpt-4o-mini"), "the model is worth seeing in the log");
  });

  it("names the provider when it cannot be reached, rather than blaming Ollama", async () => {
    // The failure that matters most: a wrong host, a dead tunnel, a typo. The
    // message has to say which endpoint failed; "fetch failed" alone sends the
    // reader to the wrong service.
    const result = generateChatResponseStream({
      messages,
      llm: llm({ baseUrl: "http://127.0.0.1:9/v1" }),
    });

    await assert.rejects(
      () => result.stream.getReader().read(),
      (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal((error as Error).name, "ModelProviderError");
        assert.match(error.message, /could not be reached/);
        assert.match(error.message, /127\.0\.0\.1:9\/v1\/chat\/completions/);
        return true;
      }
    );
  });

  it("answers a non-streaming call with the provider's content", async () => {
    reset();
    answer = {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content: "  chào bạn  " } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    };

    assert.equal(await generateChatResponse({ messages, llm: llm() }), "chào bạn");
    assert.equal(seen[0]?.authorization, "Bearer sk-live-abc123");
  });
});

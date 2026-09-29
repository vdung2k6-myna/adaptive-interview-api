import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { generateChatResponseStream } from "./ollama";

/**
 * What the streaming chat call reports about its own cost.
 *
 * Ollama sends `prompt_eval_count`, `prompt_eval_cached_count` and `eval_count`
 * on the final NDJSON chunk of a streamed chat, and the parser read only
 * `message.content` and `done` — so the one exact measurement of a turn's prompt
 * size was discarded at the last step. These tests pin the final chunk's
 * contract: what it carries is logged once per call, and a stream that ends
 * without it stays silent rather than throwing or logging `undefined`.
 *
 * The stub is a real HTTP server rather than a stubbed `fetch`, because what is
 * under test is the parser's handling of a streamed body — and it is the pattern
 * `src/lib/audio/client.test.ts` already uses for a service this repo talks to.
 * Logging, not a returned field, is where the counts surface, so the assertions
 * read what an operator would see in the log.
 */
describe("generateChatResponseStream token counts", () => {
  let server: Server;
  /** The NDJSON the stub answers the next request with. Each test sets it before
   * driving, so the file needs one server rather than one per test. */
  let ndjson: string;
  /** Everything logged during one test. */
  let logs: string[];

  before(async () => {
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(ndjson);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const { port } = server.address() as AddressInfo;
    // `generateChatResponseStream` reads the environment variable first and
    // `config` second, so the environment is the only lever that works here —
    // the opposite of the STT client, which reads `config` alone.
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    delete process.env.OLLAMA_BASE_URL;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => mock.restoreAll());

  /** Run one streamed call against the stub and read the stream to its end. */
  async function drive(): Promise<string> {
    logs = [];
    mock.method(console, "log", (...args: unknown[]) => {
      logs.push(args.join(" "));
    });

    const result = generateChatResponseStream({
      model: "stub-model",
      messages: [{ role: "user", content: "hello" }],
    });

    const reader = result.stream.getReader();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
    }
    return text;
  }

  /** The chunks Ollama actually sends: content on the way, counts on the last. */
  function finalChunk(counts: Record<string, number | string>): string {
    return JSON.stringify({ done: true, done_reason: "stop", ...counts });
  }

  it("logs the counts the final chunk carries, once", async () => {
    ndjson = [
      JSON.stringify({ message: { content: "Hello" }, done: false }),
      JSON.stringify({ message: { content: " world" }, done: false }),
      finalChunk({
        prompt_eval_count: 36,
        prompt_eval_cached_count: 12,
        eval_count: 8,
      }),
      "",
    ].join("\n");

    const text = await drive();

    assert.equal(text, "Hello world", "the content still streams through");
    assert.equal(logs.length, 1, `one line per chat call, got ${JSON.stringify(logs)}`);
    assert.match(logs[0], /stub-model/, "the line names the model the call was made with");
    assert.match(logs[0], /\bprompt_eval_count=36/);
    assert.match(logs[0], /\bprompt_eval_cached_count=12/);
    assert.match(logs[0], /\beval_count=8/);
  });

  it("leaves out the fields the service did not send", async () => {
    ndjson = [
      JSON.stringify({ message: { content: "partial" }, done: false }),
      finalChunk({ prompt_eval_count: 41 }),
      "",
    ].join("\n");

    await drive();

    assert.equal(logs.length, 1);
    assert.match(logs[0], /\bprompt_eval_count=41/);
    assert.doesNotMatch(logs[0], /undefined/, "an unsent count must not be logged as undefined");
    // `\b` so this does not pass on the `prompt_eval_count` above.
    assert.doesNotMatch(logs[0], /\beval_count=/, "a count the service omitted is not a zero");
  });

  it("logs nothing when the stream ends without counts", async () => {
    ndjson = [
      JSON.stringify({ message: { content: "No counts here" }, done: false }),
      finalChunk({}),
      "",
    ].join("\n");

    const text = await drive();

    assert.equal(text, "No counts here");
    assert.deepEqual(logs, [], "an absent count is neither a zero nor a log line");
  });

  it("logs nothing when the stream ends before the final chunk arrives", async () => {
    // A connection that closed mid-answer: no `done` chunk, so nothing to report.
    ndjson = `${JSON.stringify({ message: { content: "cut short" }, done: false })}\n`;

    const text = await drive();

    assert.equal(text, "cut short");
    assert.deepEqual(logs, []);
  });

  it("logs the counts from a final chunk that arrives without a trailing newline", async () => {
    // The parser holds a partial trailing line back, so a final chunk that is not
    // newline-terminated takes the other path through the same capture.
    ndjson =
      `${JSON.stringify({ message: { content: "unterminated" }, done: false })}\n` +
      JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 3 });

    const text = await drive();

    assert.equal(text, "unterminated");
    assert.equal(logs.length, 1, `expected the counts, got ${JSON.stringify(logs)}`);
    assert.match(logs[0], /prompt_eval_count=12/);
    assert.match(logs[0], /eval_count=3/);
  });
});

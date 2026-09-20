import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { createVoiceRouter, type VoiceRouteDeps } from "./voice";

interface Harness {
  /** The text of every chunk the route asked to synthesize, in order — what the
   * route actually spoke, which is not the same claim as what it emitted. */
  calls: string[];
  /** Everything the route logged while serving, so a test can tell a silently
   * dropped chunk from a reported one. */
  logs: string[];
}

/**
 * Drive `/speak-stream` with a synthesizer a test supplies, so the endpoint's SSE
 * contract is assertable with no audio gateway (design D8). This is not a
 * convenience: the gateway running on this machine rejects the voice this route
 * resolves, so there is no configuration in which the real synthesizer produces
 * audio here.
 *
 * The fake answers with a buffer derived from the chunk it was given, so a test
 * can tie an event's `audioData` back to the exact text it belongs to rather than
 * to a fixed string. `reply` may throw, which is how one chunk is made to fail.
 */
function harness(
  reply: (chunk: string, call: number) => Buffer | Promise<Buffer>
): Harness & { deps: Partial<VoiceRouteDeps> } {
  const calls: string[] = [];
  const logs: string[] = [];

  return {
    calls,
    logs,
    deps: {
      synthesizeSpeechWithFallback: async (chunk) => {
        const call = calls.length;
        calls.push(chunk);
        return await reply(chunk, call);
      },
    },
  };
}

/** The endpoints these tests use, as bound for one test. */
interface Endpoints {
  /** POST here to speak a whole text, streamed back as base64 chunks. */
  speak: string;
  /** POST here to start an interview session — the composition guard below. */
  start: string;
  /** Resolves once the server has seen the client's connection close. It is
   * registered on the socket, and Node tears the socket down before the response
   * is destroyed, so it fires after the route's own `res.on("close")` has run —
   * which is what makes the disconnection test below a check, not a race. */
  clientDisconnected: Promise<void>;
}

/** Mount the router on a bare app, bound to an ephemeral port. */
async function withServer(
  deps: Partial<VoiceRouteDeps>,
  fn: (api: Endpoints) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/voice", createVoiceRouter(deps));

  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
  });

  let markDisconnected = () => {};
  const clientDisconnected = new Promise<void>((resolve) => {
    markDisconnected = resolve;
  });
  server.on("connection", (socket) => socket.on("close", () => markDisconnected()));

  const address = server.address();
  assert.ok(address && typeof address === "object", "expected the app to bind a port");
  const base = `http://127.0.0.1:${address.port}/api/voice`;

  try {
    await fn({ speak: `${base}/speak-stream`, start: `${base}/start`, clientDisconnected });
  } finally {
    // A test that aborted mid-stream leaves its socket in the client's keep-alive
    // pool, and `close()` would wait out the pool's 4s idle timeout for it.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Run `fn` with the route's logging captured into the harness rather than
 * printed — it logs on every skipped chunk. */
async function captureConsole<T>(harnessed: Harness, fn: () => Promise<T>): Promise<T> {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => {
    harnessed.logs.push(args.map(String).join(" "));
  };
  console.log = capture as typeof console.log;
  console.warn = capture as typeof console.warn;
  console.error = capture as typeof console.error;

  try {
    return await fn();
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
}

/** One SSE event as it went over the wire. */
interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** The events of one response body, in the order they were written. */
function parseSse(body: string): SseEvent[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const field = (prefix: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(prefix))
          ?.slice(prefix.length) ?? "";
      return { event: field("event: "), data: JSON.parse(field("data: ")) };
    });
}

/** POST a text and return its events. */
async function speak(
  api: Endpoints,
  harnessed: Harness,
  body: Record<string, unknown>
): Promise<SseEvent[]> {
  const response = await captureConsole(harnessed, () =>
    fetch(api.speak, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "english", ...body }),
    })
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  return parseSse(await response.text());
}

/** The `sentence` events of a response, in order. */
function sentences(events: SseEvent[]): SseEvent[] {
  return events.filter((event) => event.event === "sentence");
}

/** A sentence long enough that `splitForTTS` must break it into more than one
 * chunk, so a test can tell that splitting happens per sentence and not only at
 * sentence boundaries. */
const LONG_SENTENCE =
  "This second sentence is deliberately long enough that the splitter has to break it across more than one chunk.";

describe("POST /api/voice/speak-stream — the chunk contract", () => {
  it("numbers chunks from 0 with no gap, and speaks the text it was given", async () => {
    const h = harness((chunk) => Buffer.from(`wav:${chunk}`));

    await withServer(h.deps, async (api) => {
      const text = `One. ${LONG_SENTENCE}`;
      const events = await speak(api, h, { text });
      const chunks = sentences(events);

      assert.ok(
        chunks.length > 2,
        `expected the long sentence to be split across chunks, got ${chunks.length}`
      );
      assert.deepEqual(
        chunks.map((event) => event.data.index),
        chunks.map((_, at) => at),
        "indices must run 0..n-1 in order, since the client's cursor keys on them"
      );
      assert.deepEqual(
        chunks.map((event) => event.data.text),
        h.calls,
        "each event must carry the chunk that was synthesized, in call order"
      );
      assert.equal(
        chunks.map((event) => event.data.text).join(" "),
        text,
        "the chunks must be the input text, in order, with nothing dropped"
      );
    });
  });

  it("base64-encodes each chunk's own buffer as audioData", async () => {
    const h = harness((chunk) => Buffer.from(`wav:${chunk}`));

    await withServer(h.deps, async (api) => {
      const chunks = sentences(await speak(api, h, { text: "One. Two." }));
      assert.equal(chunks.length, 2);

      for (const { data } of chunks) {
        assert.equal(typeof data.audioData, "string");
        assert.equal(
          Buffer.from(data.audioData as string, "base64").toString("utf8"),
          `wav:${data.text}`,
          "audioData must be the buffer synthesized for this event's text"
        );
      }
    });
  });

  it("ends with an empty done, and emits nothing after it", async () => {
    const h = harness(() => Buffer.alloc(4));

    await withServer(h.deps, async (api) => {
      const events = await speak(api, h, { text: "One. Two." });
      const dones = events.filter((event) => event.event === "done");

      assert.equal(dones.length, 1, "exactly one done ends the stream");
      assert.equal(events.at(-1)?.event, "done", "done must be the last event");
      assert.deepEqual(dones[0].data, {}, "speak-stream's done carries no payload");
    });
  });

  it("reports a failed chunk as null audio at its own index, and keeps speaking", async () => {
    const h = harness((chunk, call) => {
      if (call === 1) throw new Error("audio gateway refused this chunk");
      return Buffer.from(`wav:${chunk}`);
    });

    await withServer(h.deps, async (api) => {
      const events = await speak(api, h, { text: "One. Two. Three." });
      const chunks = sentences(events);

      assert.deepEqual(
        chunks.map((event) => event.data.index),
        [0, 1, 2],
        "a failed chunk keeps its index instead of leaving a gap"
      );
      assert.equal(chunks[1].data.audioData, null, "the failure is reported, not omitted");
      assert.equal(typeof chunks[0].data.audioData, "string");
      assert.equal(typeof chunks[2].data.audioData, "string");
      assert.deepEqual(h.calls, ["One.", "Two.", "Three."], "the stream continues past the failure");
      assert.equal(events.at(-1)?.event, "done", "one unpronounceable chunk must not end the turn");
      assert.ok(
        h.logs.some((line) => line.includes("TTS skipped for chunk 1")),
        `the skip must be reported, not silent — logged: ${h.logs.join(" | ")}`
      );
    });
  });

  it("stops synthesizing once the client disconnects, and never writes done", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async (chunk, call) => {
      if (call === 1) await held;
      return Buffer.from(`wav:${chunk}`);
    });

    await withServer(h.deps, async (api) => {
      const controller = new AbortController();
      let received = "";
      const response = await captureConsole(h, () =>
        fetch(api.speak, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "One. Two. Three.", language: "english" }),
          signal: controller.signal,
        })
      );

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (!received.includes("event: sentence")) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      assert.match(
        received,
        /event: sentence/,
        "the first chunk must arrive before the disconnection, or nothing is being tested"
      );

      controller.abort();
      await api.clientDisconnected;
      // A macrotask of slack: the route's own `res.on("close")`, and so the abort
      // it triggers, is queued as a nextTick — which always runs before this.
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await new Promise((resolve) => setImmediate(resolve));

      // A client cannot see writes to its own dead socket, so "no done was
      // written" is not the falsifiable claim here — this is: the route stops
      // asking for audio. Had the disconnect gone unnoticed, releasing the held
      // chunk would have resumed the loop into the third chunk.
      assert.deepEqual(
        h.calls,
        ["One.", "Two."],
        "no chunk may be synthesized after the client disconnects"
      );
      assert.doesNotMatch(received, /event: done/);
    });
  });
});

describe("POST /api/voice/speak-stream — the router's other routes", () => {
  it("still serves the routes that never moved", async () => {
    // The injection seam (design D8) is built by composing the module's original
    // router, so the risk it carries is a route quietly falling out of the chain.
    // `/start` answering its own validation proves the inner router is still in
    // it — and this suite is the only test `src/routes/voice.ts` has.
    const h = harness(() => Buffer.alloc(0));

    await withServer(h.deps, async (api) => {
      const response = await captureConsole(h, () =>
        fetch(api.start, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      );

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "sessionId is required" });
    });
  });
});

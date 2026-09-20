import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SentenceStream, type ChunkEvent, type SentenceStreamOptions } from "./sentence-stream";
import { splitForTTS } from "./text-processing";

/** A sentence long enough that `splitForTTS` must break it into more than one
 * chunk, so a test can tell per-sentence splitting from per-chunk behavior. */
const LONG_SENTENCE =
  "A single sentence long enough that the splitter has to break it into more than one chunk.";

/** Everything the core did, recorded — so a test asserts on what reached the
 * sink and what the sink asked for, which are different claims. */
interface Recorder {
  /** Every chunk handed to the sink, in order. */
  chunks: ChunkEvent[];
  /** Every chunk text the core handed to the synthesizer, in order. */
  synthCalls: string[];
  /** Every failure the core reported rather than swallowed. */
  reported: { error: unknown; index: number; text: string }[];
}

/**
 * A stream whose synthesizer and sink a test supplies, which is what makes this
 * suite need no HTTP server and no audio gateway (D7) — nothing here opens a
 * socket or reads configuration.
 *
 * `synthesize` answers with a buffer derived from the chunk, so a test can tie
 * `buffer` back to its own `text`; it may hold or throw, which is how a chunk is
 * made slow or made to fail.
 */
function recorder(
  synthesize: (chunk: string, call: number) => Buffer | Promise<Buffer> = (chunk) =>
    Buffer.from(`wav:${chunk}`),
  options: { signal?: AbortSignal; failSinkFor?: number } = {}
): { stream: SentenceStream; recorded: Recorder } {
  const recorded: Recorder = { chunks: [], synthCalls: [], reported: [] };

  const stream = new SentenceStream({
    synthesize: async (chunk) => {
      const call = recorded.synthCalls.length;
      recorded.synthCalls.push(chunk);
      return await synthesize(chunk, call);
    },
    onChunk: (chunk) => {
      if (chunk.index === options.failSinkFor) {
        throw new Error("the sink refused this chunk");
      }
      recorded.chunks.push(chunk);
    },
    onError: (error, chunk) => {
      recorded.reported.push({ error, index: chunk.index, text: chunk.text });
    },
    signal: options.signal,
  } satisfies SentenceStreamOptions);

  return { stream, recorded };
}

/** Let every pending microtask and one macrotask pass, so a test can assert that
 * something has *not* happened yet rather than merely that it happened later. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A gate a test opens by hand, for holding a chunk in flight. */
function gate(): { held: Promise<void>; open: () => void } {
  let open = () => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open };
}

describe("SentenceStream — the index contract", () => {
  it("numbers chunks from 0 across sentences and across a multi-chunk sentence", async () => {
    const { stream, recorded } = recorder();

    // Pushed without awaiting, which is the voice agent's shape for sentences
    // that arrive while an earlier sentence is still being synthesized.
    const pushed = ["One.", "Two.", LONG_SENTENCE].map((sentence) => stream.push(sentence));
    await stream.flush();
    await Promise.all(pushed);

    const expected = ["One.", "Two.", ...splitForTTS(LONG_SENTENCE)];
    assert.ok(expected.length > 3, "the long sentence must split, or this proves nothing");
    assert.deepEqual(
      recorded.chunks.map((chunk) => chunk.index),
      expected.map((_, at) => at),
      "indices must run 0..n-1 in emission order, with no gap"
    );
    assert.deepEqual(recorded.chunks.map((chunk) => chunk.text), expected);
    assert.deepEqual(
      recorded.synthCalls,
      expected,
      "the core must synthesize in index order, each chunk once"
    );
    assert.deepEqual(
      recorded.chunks.map((chunk) => chunk.buffer?.toString("utf8")),
      expected.map((chunk) => `wav:${chunk}`),
      "each chunk must carry the buffer synthesized for its own text"
    );
  });

  it("resolves push() only once that sentence's chunks have been emitted", async () => {
    // The voice agent's wire order rests on this: it emits its `text` event
    // before pushing, so a push that resolved early would put the next
    // sentence's `text` ahead of this sentence's chunks (D2).
    const { held, open } = gate();
    const { stream, recorded } = recorder(async (chunk, call) => {
      if (call === 0) await held;
      return Buffer.from(`wav:${chunk}`);
    });

    let resolved = false;
    const pushed = stream.push(LONG_SENTENCE).then(() => {
      resolved = true;
    });

    await settle();
    assert.equal(resolved, false, "push must not resolve while a chunk is still unemitted");
    assert.deepEqual(recorded.chunks, [], "nothing may be emitted before its chunk is synthesized");

    open();
    await pushed;
    assert.equal(recorded.chunks.length, splitForTTS(LONG_SENTENCE).length);
  });

  it("emits a failed chunk as null at its own index, and keeps going", async () => {
    const { stream, recorded } = recorder((chunk, call) => {
      if (call === 1) throw new Error("audio gateway refused this chunk");
      return Buffer.from(`wav:${chunk}`);
    });

    await Promise.all(["One.", "Two.", "Three."].map((sentence) => stream.push(sentence)));
    await stream.flush();

    assert.deepEqual(
      recorded.chunks.map((chunk) => chunk.index),
      [0, 1, 2],
      "a failed chunk keeps its index rather than leaving a gap"
    );
    assert.equal(recorded.chunks[1].buffer, null, "the failure is reported, not omitted");
    assert.equal(recorded.chunks[0].buffer?.toString("utf8"), "wav:One.");
    assert.equal(recorded.chunks[2].buffer?.toString("utf8"), "wav:Three.");
    assert.deepEqual(recorded.synthCalls, ["One.", "Two.", "Three."], "the stream must continue");
    assert.equal(recorded.reported.length, 1, "the failure must be reported, not swallowed");
    assert.equal(recorded.reported[0].index, 1);
    assert.equal(recorded.reported[0].text, "Two.");
  });

  it("reports a throwing sink without stopping the stream", async () => {
    const { stream, recorded } = recorder(undefined, { failSinkFor: 1 });

    await Promise.all(["One.", "Two.", "Three."].map((sentence) => stream.push(sentence)));
    await stream.flush();

    assert.deepEqual(
      recorded.chunks.map((chunk) => chunk.index),
      [0, 2],
      "the chunk after a refused sink call must still be emitted"
    );
    assert.equal(recorded.reported.length, 1);
    assert.equal(recorded.reported[0].index, 1);
  });
});

describe("SentenceStream — flush() and abort", () => {
  it("resolves flush() only after the last chunk has been emitted", async () => {
    const { held, open } = gate();
    const { stream, recorded } = recorder(async (chunk, call) => {
      if (call === 2) await held;
      return Buffer.from(`wav:${chunk}`);
    });

    await Promise.all(["One.", "Two."].map((sentence) => stream.push(sentence)));
    // The third chunk is held, so this promise cannot settle yet — which is
    // exactly what flush() has to wait for, so it must not be awaited here.
    const pushed = stream.push("Three.");
    await settle();

    let flushed = false;
    const drained = stream.flush().then(() => {
      flushed = true;
    });

    await settle();
    assert.equal(flushed, false, "flush must not resolve while a chunk is in flight");
    assert.deepEqual(recorded.chunks.map((chunk) => chunk.index), [0, 1]);

    open();
    await drained;
    await pushed;
    assert.deepEqual(recorded.chunks.map((chunk) => chunk.index), [0, 1, 2]);
  });

  it("stops emission on abort, and still resolves flush() and every push", async () => {
    const { held, open } = gate();
    const controller = new AbortController();
    const { stream, recorded } = recorder(
      async (chunk, call) => {
        if (call === 0) await held;
        return Buffer.from(`wav:${chunk}`);
      },
      { signal: controller.signal }
    );

    const pushed = ["One.", "Two.", LONG_SENTENCE].map((sentence) => stream.push(sentence));
    await settle();

    // Aborted while the first chunk is in flight: the buffer it is waiting on
    // must be dropped rather than emitted, and the queue behind it abandoned.
    controller.abort();
    open();

    await assert.doesNotReject(async () => {
      await Promise.all(pushed);
      await stream.flush();
    });
    assert.deepEqual(recorded.chunks, [], "nothing may be emitted after the abort");
    assert.deepEqual(recorded.reported, [], "an abort is not a failure to report");

    // And a push after the abort schedules nothing at all.
    const after = recorded.synthCalls.length;
    await assert.doesNotReject(() => stream.push("Three."));
    assert.equal(recorded.synthCalls.length, after, "a push after abort must not synthesize");
    assert.deepEqual(recorded.chunks, []);
  });
});

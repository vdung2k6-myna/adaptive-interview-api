/**
 * The shared scheduler that turns sentences into indexed, synthesized chunks.
 *
 * Four loops in this repo do this job: `synthesizeLongText`
 * (`text-processing.ts:894`), `/api/voice/stream` and `/api/voice/speak-stream`
 * (`voice.ts`), and `/api/voice-agent/stream` (`voice-agent.ts`). Two of them
 * call in here — speak-stream and the voice agent — because they emit the same
 * envelope and synthesize serially. The other two keep their own loops, and
 * deliberately: `synthesizeLongText` concatenates WAVs instead of emitting
 * anything, and `/api/voice/stream` writes audio files and emits URLs. Copy the
 * loop that matches what you are changing.
 *
 * What the core owns, and what a caller must not re-implement (D3): the chunk
 * index. It is per-stream, monotonic from 0, and `onChunk` is called in index
 * order. No index is ever skipped, and nothing is emitted after an abort. This
 * is not bookkeeping — the client orders playback by index through an
 * expected-index cursor, so a gap stalls it indefinitely rather than degrading,
 * and an out-of-order chunk is played out of order.
 *
 * What the caller still owns: the transport. The core never sees `req` or `res`,
 * emission happens in the caller's `onChunk` because the sinks differ (the voice
 * agent also guards on `res.writableEnded`, which the core cannot know), and the
 * caller still emits its own `text` and `done` events around it (D1, D5).
 */

import { splitForTTS } from "./text-processing";

/** One chunk, on its way to a caller's sink. */
export interface ChunkEvent {
  /** Per-stream, monotonic from 0, never skipped (D3). */
  index: number;
  /** The text spoken — one of `splitForTTS(sentence)`'s chunks (D6). */
  text: string;
  /** The audio, or `null` for a chunk that failed — or for one the caller chose
   * not to synthesize, which is a muted turn. A chunk with no audio is emitted at
   * its own index rather than omitted, so the caller's index sequence keeps its
   * shape and the client's cursor keeps advancing (D4). */
  buffer: Buffer | null;
}

/** A chunk waiting its turn. `settle` releases the `push` that scheduled it. */
interface QueuedChunk {
  index: number;
  text: string;
  settle: () => void;
}

export interface SentenceStreamOptions {
  /**
   * Synthesizes one chunk. Injected rather than imported, so the core needs no
   * audio gateway — which is the whole point of it being testable (D7) — and so
   * each caller keeps its own options, voice and signal.
   *
   * A throw is a failed chunk, not a broken stream: it is reported through
   * `onError` and emitted as `buffer: null` (D4). An `AbortError` is treated as
   * the stream having been aborted.
   *
   * Answering `null` is the other way to a chunk with no audio, and it is not a
   * failure: nothing is reported, and the chunk is emitted at its index exactly
   * as a failed one is — which is how a caller streams a turn's text without
   * synthesizing any of it.
   */
  synthesize: (chunk: string) => Promise<Buffer | null>;
  /** Called once per chunk, in index order. Emission is the caller's job, so
   * this is where a caller writes its own event. A throw from here is reported
   * through `onError` and does not stop the stream. */
  onChunk: (chunk: ChunkEvent) => void;
  /** Stops the stream. Nothing is emitted once it is aborted, and `flush()`
   * still resolves, so a caller can abandon the response it was filling (D5). */
  signal?: AbortSignal;
  /** Reports a failed chunk (D4) or a throwing sink. Defaults to `console.error`;
   * both callers pass their own so the message they log keeps naming the route. */
  onError?: (error: unknown, chunk: { index: number; text: string }) => void;
}

/**
 * A `AbortError` by name, without requiring an `Error` instance: the audio
 * library's own abort is a `DOMException`, and a rejected `fetch` in the gateway
 * client is not always an `Error` subclass.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export class SentenceStream {
  private readonly queue: QueuedChunk[] = [];
  private nextIndex = 0;
  private draining: Promise<void> | null = null;

  constructor(private readonly options: SentenceStreamOptions) {}

  /** True once the caller's signal says the client is gone (D5). */
  private get aborted(): boolean {
    return this.options.signal?.aborted === true;
  }

  /**
   * Schedules one sentence's chunks and returns when they have been emitted (or
   * abandoned by an abort). Callers pass *sentences*: the core splits them with
   * `splitForTTS`, which is the function both callers already split with, so the
   * chunks are unchanged by the move (D6).
   *
   * Synthesis is serial, in push order, so awaiting this preserves the caller's
   * own interleaving — the voice agent relies on that: its token read loop
   * awaits TTS between reads today, and a move that let synthesis run ahead of
   * the loop would emit `text` events before the previous sentence's chunks
   * (D2). A caller that does not await still gets ordered chunks, only later.
   */
  push(sentence: string): Promise<void> {
    if (this.aborted) {
      return Promise.resolve();
    }

    let pending = 0;
    let release!: () => void;
    const emitted = new Promise<void>((resolve) => {
      release = resolve;
    });

    for (const text of splitForTTS(sentence)) {
      pending++;
      let settled = false;
      this.queue.push({
        index: this.nextIndex++,
        text,
        settle: () => {
          if (settled) return;
          settled = true;
          if (--pending === 0) release();
        },
      });
    }

    // splitForTTS always returns at least one chunk, so `pending` is never 0.
    void this.drain();
    return emitted;
  }

  /**
   * Resolves once every chunk pushed so far has been emitted — which is the
   * point a caller may safely write its closing `done`, and not before, since
   * the client would otherwise be told the stream ended while chunks were still
   * arriving.
   *
   * The condition is re-checked rather than awaited once, because a drain can
   * empty the queue between two pushes.
   */
  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.draining) {
      if (!this.draining) {
        this.drain();
      }
      await this.draining;
    }
  }

  /** Starts the drain if one is not already running. */
  private drain(): Promise<void> {
    this.draining ??= this.runQueue();
    return this.draining;
  }

  /** Emits chunks in index order until the queue empties or the stream aborts. */
  private async runQueue(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];

        if (this.aborted) {
          this.abandon();
          return;
        }

        let buffer: Buffer | null = null;
        try {
          buffer = await this.options.synthesize(item.text);
        } catch (error) {
          // An abort is not a failure to report — the caller asked for this.
          if (this.aborted || isAbortError(error)) {
            this.abandon();
            return;
          }
          this.report(error, item);
        }

        // The client may have gone while we were synthesizing. The buffer is
        // dropped, exactly as both callers drop it today (D5).
        if (this.aborted) {
          this.abandon();
          return;
        }

        this.queue.shift();
        this.emit({ index: item.index, text: item.text, buffer });
        item.settle();
      }
    } finally {
      this.draining = null;
    }
  }

  /** Drops what is left without emitting it, releasing every waiting `push`. */
  private abandon(): void {
    for (const item of this.queue.splice(0)) {
      item.settle();
    }
  }

  /** Hands a chunk to the caller's sink, which is not allowed to break the
   * stream: its throw is reported like a failed chunk and the next chunk is
   * still emitted (D5). */
  private emit(chunk: ChunkEvent): void {
    try {
      this.options.onChunk(chunk);
    } catch (error) {
      this.report(error, chunk);
    }
  }

  private report(error: unknown, chunk: { index: number; text: string }): void {
    if (this.options.onError) {
      this.options.onError(error, chunk);
      return;
    }
    console.error(
      `[SentenceStream] chunk ${chunk.index} ("${chunk.text.slice(0, 40)}") failed:`,
      error
    );
  }
}

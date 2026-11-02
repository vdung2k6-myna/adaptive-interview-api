import { describe, it } from "node:test";
import assert from "node:assert/strict";

import config from "@/lib/config";
import type { TranscriptionResult } from "./client";
import { transcribeAudio, transcriptionQueueStats } from "./stt";

/**
 * The transcription bound as a queue, not as a timeout.
 *
 * What is asserted is the shape the old path got wrong: the service is called only
 * after a slot is held, a turn that ends while queued never reaches the service, and
 * the queue reports both halves of its state while it waits.
 */

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the transcription bound", () => {
  it("makes a burst wait, and an aborted turn never reaches the service", async () => {
    const limit = config.audio.transcriptionConcurrency;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const client = {
      async transcribe(audioPath: string): Promise<TranscriptionResult> {
        seen.push(audioPath);
        await gate;
        return { text: "ok" };
      },
    };

    const holders = Array.from({ length: limit }, (_unused, index) =>
      transcribeAudio(`hold-${index}`, undefined, undefined, undefined, undefined, client)
    );
    // Let every holder reach the service; the queue is only meaningful once full.
    for (let waited = 0; waited < 100 && seen.length < limit; waited++) await pause(5);
    assert.equal(seen.length, limit, "every slot is in use");

    const controller = new AbortController();
    const queued = transcribeAudio("queued", undefined, undefined, undefined, controller.signal, client);
    await pause(10);
    assert.equal(transcriptionQueueStats().waiting, 1, "the fifth request is waiting");
    assert.equal(transcriptionQueueStats().inFlight, limit);

    controller.abort();
    await assert.rejects(queued);

    release();
    await Promise.all(holders);
    assert.equal(
      seen.includes("queued"),
      false,
      "a turn that ended while queued never sent its request"
    );
    assert.equal(transcriptionQueueStats().inFlight, 0);
    assert.equal(transcriptionQueueStats().waiting, 0);
  });
});

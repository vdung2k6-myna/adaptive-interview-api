import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import config from "@/lib/config";
import { AudioGatewayClient, synthesisQueueStats } from "./client";
import { synthesizeSpeechWithFallback } from "./text-processing";
import { synthesizeSpeech } from "./tts";

/**
 * The synthesis admission every turn shares.
 *
 * Each test fills the bound with requests the stub never answers, so the next
 * one must queue; that is the state the checks are about. The semaphore is
 * module-level, so every test releases what it took before the next begins.
 */
describe("the synthesis admission bound", () => {
  let gateway: Server;
  let baseUrl: string;
  /** One resolver per request the stub has accepted, in arrival order. */
  let accepted: (() => void)[] = [];
  /** Controllers for the requests each test leaves hanging. */
  let controllers: AbortController[] = [];

  before(async () => {
    gateway = createServer((_req, res) => {
      accepted.push(() => {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(wav());
      });
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const controller of controllers) controller.abort();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });

  beforeEach(async () => {
    for (const controller of controllers) controller.abort();
    await waitFor(() => synthesisQueueStats().inFlight === 0, "the previous test's slots to be released");
    accepted = [];
    controllers = [];
  });

  /** The smallest thing the client accepts as a WAV answer. */
  function wav(): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(0, 40);
    return header;
  }

  function holdOne(client = new AudioGatewayClient(), signal?: AbortSignal): Promise<Buffer> {
    const controller = new AbortController();
    controllers.push(controller);
    // A queued caller may be aborted by the test; its rejection is asserted by
    // the test that owns it, so this call site only keeps it from going unhandled.
    const pending = client.synthesize("hello", {
      baseUrl,
      engine: "kokoro",
      voice: "example_voice",
      signal: signal ?? controller.signal,
    });
    pending.catch(() => {});
    return pending;
  }

  /** Fill every slot with a request the stub is holding open. */
  async function occupyEverySlot(): Promise<void> {
    const bound = config.audio.synthesisAdmission;
    for (let index = 0; index < bound; index++) holdOne();
    await waitFor(
      () => synthesisQueueStats().inFlight === bound && accepted.length === bound,
      "every slot to be occupied"
    );
  }

  it("drops a queued synthesis when its turn ends, without sending it", async () => {
    await occupyEverySlot();
    const bound = config.audio.synthesisAdmission;

    const turn = new AbortController();
    const queued = holdOne(undefined, turn.signal);
    await waitFor(() => synthesisQueueStats().waiting === 1, "the fifth synthesis to queue");

    turn.abort();

    await assert.rejects(queued, (err: Error) => err.name === "AbortError");
    assert.equal(synthesisQueueStats().waiting, 0, "the queue is empty again");
    assert.equal(accepted.length, bound, "the aborted turn sent no request");
  });

  it("hands the slot to the next waiter when a turn ends early", async () => {
    await occupyEverySlot();
    const bound = config.audio.synthesisAdmission;

    const next = holdOne();
    await waitFor(() => synthesisQueueStats().waiting === 1, "the fifth synthesis to queue");

    controllers[0]!.abort();

    await waitFor(
      () => synthesisQueueStats().waiting === 0 && accepted.length === bound + 1,
      "the queued synthesis to be admitted"
    );
    assert.equal(synthesisQueueStats().inFlight, bound, "the released slot was handed over, not opened twice");
    next.catch(() => {});
  });

  it("keeps both synthesis callers under the one bound", async () => {
    const bound = config.audio.synthesisAdmission;
    let active = 0;
    let maxActive = 0;
    const slow = createServer((_req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Answer, but only after a moment, so overlapping calls are observable.
      setTimeout(() => {
        active -= 1;
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(wav());
      }, 20);
    });
    slow.listen(0, "127.0.0.1");
    await once(slow, "listening");
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    const options = { baseUrl: slowUrl, engine: "kokoro" as const, voice: "example_voice" };

    try {
      // One caller is the gadget turn's fallback synthesizer; the other is the
      // transcription replay's plain one. Both reach the same client method.
      const calls = Array.from({ length: bound * 3 }, (_, index) =>
        index % 2 === 0
          ? synthesizeSpeech("hello", options)
          : synthesizeSpeechWithFallback("hello", options)
      );
      const buffers = await Promise.all(calls);
      assert.equal(buffers.length, bound * 3);
      assert.ok(maxActive <= bound, `the gateway saw ${maxActive} at once; the bound is ${bound}`);
      assert.ok(maxActive >= 2, "the callers really were concurrent");
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
      await waitFor(() => synthesisQueueStats().inFlight === 0, "the slots to be released");
    }
  });

  it("starts the admitted request's timeout only after admission", async () => {
    await occupyEverySlot();

    const shortTimeout = new AudioGatewayClient({ timeoutMs: 100 });
    let settled = false;
    const queued = holdOne(shortTimeout).finally(() => {
      settled = true;
    });
    queued.catch(() => {});

    await waitFor(() => synthesisQueueStats().waiting === 1, "the fifth synthesis to queue");
    // Longer than the admitted request's own timeout: a timer that started while
    // queued would have fired by now.
    await delay(250);
    assert.equal(settled, false, "a queued synthesis is not timed out for waiting");

    controllers[0]!.abort();
    await waitFor(() => accepted.length === config.audio.synthesisAdmission + 1, "admission");

    // Admitted now, and the request's own timeout applies in full.
    await assert.rejects(queued, (err: Error) => err.name === "AbortError");
  });
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

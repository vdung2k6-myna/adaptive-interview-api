import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { createMetricsRouter } from "./metrics";
import { apiAuthMiddleware } from "../middleware/auth";
import { AudioGatewayClient, synthesisQueueStats } from "../lib/audio/client";
import config from "@/lib/config";

/** Armed deliberately: an unset token disables authentication, which would make
 *  the refusal below pass for the wrong reason. */
const TOKEN = "test-token-for-the-queue-metrics";

interface QueueCounts {
  inFlight: number;
  waiting: number;
}

interface MetricsBody {
  ollama: QueueCounts;
  stt: QueueCounts;
  tts: QueueCounts;
}

async function withServer(
  fn: (url: string, authorized: () => Promise<Response>) => Promise<void>
): Promise<void> {
  const previousToken = process.env.API_AUTH_TOKEN;
  process.env.API_AUTH_TOKEN = TOKEN;

  const app = express();
  app.use("/api", apiAuthMiddleware);
  app.use("/api/metrics", createMetricsRouter());

  let server: Server | undefined;
  try {
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object", "expected the app to bind a port");
    const url = `http://127.0.0.1:${address.port}/api/metrics`;

    await fn(url, () => fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } }));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    if (previousToken === undefined) delete process.env.API_AUTH_TOKEN;
    else process.env.API_AUTH_TOKEN = previousToken;
  }
}

describe("GET /api/metrics", () => {
  it("refuses a caller with no credential", async () => {
    await withServer(async (url) => {
      const res = await fetch(url);
      assert.equal(res.status, 401);
    });
  });

  it("reports every queue as counts to an authorised caller", async () => {
    await withServer(async (url, authorized) => {
      const res = await authorized();
      assert.equal(res.status, 200);
      const body = (await res.json()) as MetricsBody;

      assert.deepEqual(Object.keys(body).sort(), ["ollama", "stt", "tts"]);
      for (const queue of [body.ollama, body.stt, body.tts]) {
        assert.deepEqual(Object.keys(queue).sort(), ["inFlight", "waiting"]);
        assert.equal(Number.isInteger(queue.inFlight), true);
        assert.equal(Number.isInteger(queue.waiting), true);
        assert.ok(queue.inFlight >= 0 && queue.waiting >= 0);
      }
    });
  });

  it("reports the synthesis queue while replies are being spoken", async () => {
    await withServer(async (url, authorized) => {
      // A gateway that holds every request open, so each occupies an admission
      // slot for as long as the test needs it to.
      const gateway = createServer((_req, _res) => {});
      gateway.listen(0, "127.0.0.1");
      await once(gateway, "listening");
      const baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

      const bound = config.audio.synthesisAdmission;
      const controllers: AbortController[] = [];
      try {
        for (let index = 0; index < bound; index++) {
          const controller = new AbortController();
          controllers.push(controller);
          new AudioGatewayClient()
            .synthesize("hello", {
              baseUrl,
              engine: "kokoro",
              voice: "example_voice",
              signal: controller.signal,
            })
            .catch(() => {});
        }
        await waitFor(() => synthesisQueueStats().inFlight === bound, "the bound to be in flight");

        const res = await authorized();
        const body = (await res.json()) as MetricsBody;
        assert.equal(body.tts.inFlight, bound, "the report shows the syntheses in flight");
        assert.equal(body.tts.waiting, 0, "nothing is queued at the bound itself");
      } finally {
        for (const controller of controllers) controller.abort();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await waitFor(() => synthesisQueueStats().inFlight === 0, "the slots to be released");
      }
    });
  });
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

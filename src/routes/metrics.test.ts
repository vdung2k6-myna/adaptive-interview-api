import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";

import { createMetricsRouter } from "./metrics";
import { apiAuthMiddleware } from "../middleware/auth";

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

  it("reports both queues as counts to an authorised caller", async () => {
    await withServer(async (url, authorized) => {
      const res = await authorized();
      assert.equal(res.status, 200);
      const body = (await res.json()) as MetricsBody;

      assert.deepEqual(Object.keys(body).sort(), ["ollama", "stt"]);
      for (const queue of [body.ollama, body.stt]) {
        assert.deepEqual(Object.keys(queue).sort(), ["inFlight", "waiting"]);
        assert.equal(Number.isInteger(queue.inFlight), true);
        assert.equal(Number.isInteger(queue.waiting), true);
        assert.ok(queue.inFlight >= 0 && queue.waiting >= 0);
      }
    });
  });
});

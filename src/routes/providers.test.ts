import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";

import { createProvidersRouter } from "./providers";
import { apiAuthMiddleware } from "../middleware/auth";
import type { PublicProviderProfile } from "../lib/providers";

/** The token this suite arms auth with. Deliberately not the developer's: an
 * unset `API_AUTH_TOKEN` disables authentication entirely, which would make the
 * unauthorized assertion below pass for the wrong reason. */
const TOKEN = "test-token-for-the-provider-catalog";

const PROFILES: PublicProviderProfile[] = [
  {
    id: "kokoro-vi",
    kind: "tts",
    name: "Kokoro Vietnamese",
    model: "kokoro",
    voice: "example_voice",
    hasKey: false,
  },
  {
    id: "openai-stt",
    kind: "stt",
    name: "OpenAI Whisper",
    model: "whisper-1",
    voice: null,
    hasKey: true,
  },
];

async function withServer(
  fn: (url: string, authorized: () => Promise<Response>) => Promise<void>
): Promise<void> {
  const previousToken = process.env.API_AUTH_TOKEN;
  process.env.API_AUTH_TOKEN = TOKEN;

  const app = express();
  app.use(express.json());
  app.use("/api", apiAuthMiddleware);
  app.use(
    "/api/provider-profiles",
    createProvidersRouter({ listProviders: () => PROFILES })
  );

  let server: Server | undefined;
  try {
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object", "expected the app to bind a port");
    const url = `http://127.0.0.1:${address.port}/api/provider-profiles`;

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

describe("GET /api/provider-profiles", () => {
  it("answers a request with no credential as unauthorized, as every API resource does", async () => {
    await withServer(async (url) => {
      const res = await fetch(url);

      assert.equal(res.status, 401);
    });
  });

  it("lists the catalog by id, kind, name, model and voice, with no key", async () => {
    await withServer(async (_url, authorized) => {
      const res = await authorized();

      assert.equal(res.status, 200);
      const body = (await res.json()) as { profiles: PublicProviderProfile[] };
      assert.deepEqual(body.profiles, PROFILES);
      assert.equal(JSON.stringify(body).includes("apiKey"), false, "no field may carry a key");
    });
  });
});

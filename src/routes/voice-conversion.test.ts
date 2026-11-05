import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";

import { createVoiceConversionRouter } from "./voice-conversion";
import config from "@/lib/config";

const ORIGINAL = {
  ...config.audio.ovc,
  voiceAgent: { ...config.audio.ovc.voiceAgent },
};

const CLIENT = {
  status: async () => ({
    reachable: true,
    activeModel: "vctk-p225.pth",
    f0Methods: ["pm", "rmvpe"],
  }),
};

async function withServer(
  client: { status: typeof CLIENT.status },
  fn: (base: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use("/api/voice-conversion", createVoiceConversionRouter(client));
  const server: Server = await new Promise((resolve) => {
    const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}/api/voice-conversion`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /api/voice-conversion", () => {
  before(() => {
    Object.assign(config.audio.ovc, {
      url: "http://ovc.test",
      model: "vctk-p225.pth",
      required: true,
      timeoutMs: 60_000,
      voiceAgent: { pitchShift: 12, formantShift: 10, f0Method: "rmvpe" },
    });
  });

  after(() => {
    Object.assign(config.audio.ovc, ORIGINAL);
  });

  it("reports the deployment's settings and the active model", async () => {
    await withServer(CLIENT, async (base) => {
      const res = await fetch(base);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        configured: true,
        reachable: true,
        activeModel: "vctk-p225.pth",
        model: "vctk-p225.pth",
        required: true,
        timeoutMs: 60_000,
        f0Methods: ["pm", "rmvpe"],
        voiceAgent: { pitchShift: 12, formantShift: 10, f0Method: "rmvpe" },
      });
    });
  });

  it("names no service without asking the service anything", async () => {
    const previous = { ...config.audio.ovc };
    config.audio.ovc.url = "";
    try {
      await withServer(
        {
          status: async () => {
            throw new Error("the service must not be called when none is named");
          },
        },
        async (base) => {
          const res = await fetch(base);
          assert.equal(res.status, 200);
          const body = (await res.json()) as { configured: boolean; reachable: boolean };
          assert.equal(body.configured, false);
          assert.equal(body.reachable, false);
        }
      );
    } finally {
      Object.assign(config.audio.ovc, previous);
    }
  });
});

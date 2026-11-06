import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";

import { createVoiceConversionRouter } from "./voice-conversion";
import type { SynthesizeOptions } from "@/lib/audio";
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
  fn: (base: string) => Promise<void>,
  synthesize: (text: string, options: SynthesizeOptions) => Promise<Buffer> = async () =>
    Buffer.from("RIFF")
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/voice-conversion", createVoiceConversionRouter(client, synthesize));
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

describe("/api/voice-conversion", () => {
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

  it("auditions with the provider it is given and the deployment's shaping", async () => {
    const calls: { text: string; options: SynthesizeOptions }[] = [];
    await withServer(
      CLIENT,
      async (base) => {
        const res = await fetch(`${base}/audition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ttsBaseUrl: "http://tts.test/v1",
            ttsModel: "piper",
            ttsVoice: "bryce",
          }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "audio/wav");
        assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "RIFF");
      },
      async (text, options) => {
        calls.push({ text, options });
        return Buffer.from("RIFF");
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "Hello, this is how this voice sounds.");
    assert.deepEqual(calls[0].options, {
      baseUrl: "http://tts.test/v1",
      model: "piper",
      voice: "bryce",
      conversion: { pitchShift: 12, formantShift: 10, f0Method: "rmvpe" },
    });
  });

  it("auditions an off config as the provider's own voice", async () => {
    const calls: SynthesizeOptions[] = [];
    await withServer(
      CLIENT,
      async (base) => {
        const res = await fetch(`${base}/audition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ttsBaseUrl: "http://tts.test/v1",
            ttsModel: "piper",
            ttsVoice: "bryce",
            ovc: { enabled: false },
            text: "Xin chào, đây là giọng nói thử nghiệm.",
          }),
        });
        assert.equal(res.status, 200);
      },
      async (_text, options) => {
        calls.push(options);
        return Buffer.from("RIFF");
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].conversion, false);
    assert.equal(calls[0].apiKey, undefined);
  });

  it("merges a custom audition config over the deployment defaults", async () => {
    const calls: SynthesizeOptions[] = [];
    await withServer(
      CLIENT,
      async (base) => {
        const res = await fetch(`${base}/audition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ttsBaseUrl: "http://tts.test/v1",
            ttsModel: "piper",
            ttsVoice: "bryce",
            ttsApiKey: "sk-test",
            ovc: { pitchShift: 4, indexRate: 0.6, effects: { reverb: true } },
          }),
        });
        assert.equal(res.status, 200);
      },
      async (_text, options) => {
        calls.push(options);
        return Buffer.from("RIFF");
      }
    );
    assert.deepEqual(calls[0].conversion, {
      pitchShift: 4,
      formantShift: 10,
      f0Method: "rmvpe",
      indexRate: 0.6,
      effects: { reverb: true },
    });
    assert.equal(calls[0].apiKey, "sk-test");
  });

  it("refuses an audition without a provider", async () => {
    await withServer(CLIENT, async (base) => {
      const res = await fetch(`${base}/audition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttsModel: "piper", ttsVoice: "bryce" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "ttsBaseUrl is required");
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

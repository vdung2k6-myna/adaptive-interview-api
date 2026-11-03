import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderProfile } from "@/lib/providers";
import { resolveSessionVoice, type SessionVoiceDeps } from "./session-voice";

const profile: ProviderProfile = {
  id: "piper-en",
  kind: "tts",
  name: "Piper EN",
  baseUrl: "http://gateway.example:8082",
  model: "piper",
  voice: "bryce",
};

function deps(overrides: Partial<SessionVoiceDeps> = {}): SessionVoiceDeps {
  return {
    catalog: [profile],
    defaults: { llm: null, stt: null, tts: null },
    gatewayUrl: "",
    defaultEngine: undefined,
    defaultVoice: "default-voice",
    ...overrides,
  };
}

describe("resolveSessionVoice", () => {
  it("speaks a session through the profile it names", () => {
    const result = resolveSessionVoice({ ttsProfileId: "piper-en" }, "english", deps());
    assert.ok("options" in result);
    assert.deepEqual(result.options, {
      baseUrl: "http://gateway.example:8082",
      model: "piper",
      voice: "bryce",
    });
  });

  it("names a profile the deployment does not publish instead of substituting one", () => {
    const result = resolveSessionVoice({ ttsProfileId: "gone" }, "english", deps());
    assert.ok("error" in result);
    assert.match(result.error, /"gone" is not configured/);
  });

  it("serves a legacy session's engine where a gateway is configured", () => {
    const result = resolveSessionVoice(
      { ttsProvider: "piper" },
      "english",
      deps({ gatewayUrl: "http://localhost:8082" })
    );
    assert.ok("options" in result);
    assert.equal(result.options.engine, "piper");
    assert.ok(result.options.voice);
  });

  it("fails a legacy session named without a gateway, naming the missing provider", () => {
    const result = resolveSessionVoice({ ttsProvider: "piper" }, "english", deps());
    assert.ok("error" in result);
    assert.match(result.error, /no synthesis gateway is configured/);
  });

  it("answers a session that names nothing from the deployment's default profile", () => {
    const result = resolveSessionVoice({}, "english", deps({
      defaults: { llm: null, stt: null, tts: "piper-en" },
    }));
    assert.ok("options" in result);
    assert.equal(result.options.model, "piper");
  });

  it("fails a deployment with no default at all", () => {
    const result = resolveSessionVoice({}, "english", deps());
    assert.ok("error" in result);
    assert.match(result.error, /no text-to-speech provider is configured/);
  });
});

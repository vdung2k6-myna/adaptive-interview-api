import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { developmentConfig } from "./development";
import { productionConfig } from "./production";

/**
 * These assertions are about each environment's *defaults* — the value the
 * configuration falls back to when the variable is unset, which is what an
 * unconfigured deployment runs on.
 *
 * The two config objects are built once when their module is first loaded, so a
 * variable already exported by the shell that runs this suite cannot be
 * overridden from inside a test. Each message below therefore names the variable
 * it read, and reports whether it was set: a failure caused by the environment
 * then reads as that, rather than as a broken default.
 *
 * The `test` environment is not asserted here because it is development's values
 * spread under a different name (§4.1); it cannot silently lose a field, since
 * `AppConfig` requires every one of them.
 */
function envNote(name: string): string {
  const value = process.env[name];
  return value === undefined
    ? `default under test; ${name} is unset in this environment`
    : `default under test, but ${name} is set to ${JSON.stringify(value)} in this environment and overrides it`;
}

/** The environments this suite asserts, named for its failure messages. */
const ENVIRONMENTS = [
  ["development", developmentConfig],
  ["production", productionConfig],
] as const;

describe("the material settings each environment defaults to", () => {
  it("gives development the two wiki collections as its speakable set", () => {
    assert.deepEqual(
      developmentConfig.material.collections,
      ["truyen-kiem-hiep", "kiem-hiep"],
      envNote("MATERIAL_COLLECTIONS")
    );
  });

  it("leaves production's speakable set empty, so an unmeasured deployment generates every reply", () => {
    assert.deepEqual(
      productionConfig.material.collections,
      [],
      `${envNote("MATERIAL_COLLECTIONS")} — an empty set is what makes shipping the material path safe: no turn can change behaviour until a deployment sets a collection deliberately`
    );
  });

  it("leaves the joke collection out of development's speakable set", () => {
    assert.ok(
      !developmentConfig.material.collections.includes("truyen-cuoi"),
      "truyen-cuoi's stored text is OCR-corrupted, so speaking it verbatim reads as gibberish"
    );
  });

  it("gives every environment the measured floor", () => {
    for (const [name, config] of ENVIRONMENTS) {
      assert.equal(config.material.scoreFloor, 0.55, `${name}: ${envNote("MATERIAL_SCORE_FLOOR")}`);
    }
  });
});

describe("the bounds work under load is held to", () => {
  it("keeps this process below the model's measured concurrency ceiling", () => {
    // The account was measured to refuse above ~15 requests in flight
    // (docs/CAPACITY.md). Twelve is the bound that leaves room to retry before a
    // refusal ever reaches a turn.
    for (const [name, config] of ENVIRONMENTS) {
      assert.equal(
        config.ollama.maxConcurrentRequests,
        12,
        `${name}: ${envNote("OLLAMA_MAX_CONCURRENT_REQUESTS")}`
      );
    }
  });

  it("gives a refusal a deadline long enough to be retried, shorter in development", () => {
    assert.equal(
      developmentConfig.ollama.retryDeadlineMs,
      20_000,
      envNote("OLLAMA_RETRY_DEADLINE_MS")
    );
    assert.equal(
      productionConfig.ollama.retryDeadlineMs,
      30_000,
      envNote("OLLAMA_RETRY_DEADLINE_MS")
    );
  });

  it("attempts a refused request more often in production than in development", () => {
    assert.equal(developmentConfig.ollama.retries, 1, envNote("OLLAMA_RETRIES"));
    assert.equal(productionConfig.ollama.retries, 2, envNote("OLLAMA_RETRIES"));
  });

  it("bounds one turn's syntheses so a long reply cannot take the gateway", () => {
    for (const [name, config] of ENVIRONMENTS) {
      assert.equal(
        config.audio.synthesisConcurrency,
        4,
        `${name}: ${envNote("AUDIO_SYNTHESIS_CONCURRENCY")}`
      );
    }
  });
});

describe("the audio defaults an unconfigured deployment runs on", () => {
  it("names the engine and English voice the audio tier provisions", () => {
    for (const [name, config] of ENVIRONMENTS) {
      assert.equal(
        config.audio.defaultEngine,
        "piper",
        `${name}: ${envNote("DEFAULT_TTS_ENGINE")}`
      );
      assert.equal(
        config.audio.defaultVoice,
        "bryce",
        `${name}: ${envNote("DEFAULT_VOICE")}`
      );
      assert.equal(
        config.audio.voices.piper.english,
        "bryce",
        `${name}: ${envNote("PIPER_VOICE_ENGLISH")}`
      );
    }
  });
});

describe("the bounds a turn's tool calls are held to", () => {
  it("gives a turn three rounds, which is one request for a track answered in two calls", () => {
    // Two was set for a person asking for two things in one breath. A request for a track is one
    // thing answered in two rounds — the shelf, and the number on it — so three is what leaves a
    // model that wastes a round with something left to answer with.
    for (const [name, config] of ENVIRONMENTS) {
      assert.equal(config.toolCalls.maxRounds, 3, `${name}: ${envNote("TOOL_CALL_MAX_ROUNDS")}`);
    }
  });

  it("holds a turn open for a gadget for the same eight seconds in both environments", () => {
    for (const [name, config] of ENVIRONMENTS) {
      assert.equal(config.toolCalls.timeoutMs, 8_000, `${name}: ${envNote("TOOL_CALL_TIMEOUT_MS")}`);
    }
  });
});

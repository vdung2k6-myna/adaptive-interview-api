import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import config from "@/lib/config";
import { audioGateway } from "./client";
import { resolveVoice } from "./text-processing";
import {
  configuredSupertonicVoices,
  unavailableConfiguredVoices,
  unavailableVoices,
} from "./voice-catalog";

/**
 * These tests never reach the audio stack: the comparison is pure, and the one
 * async function is exercised against a stubbed gateway client. The point of
 * the check is to catch a configured voice name that holds no style before a
 * turn speaks in the wrong voice, so the property that matters is that every
 * name `resolveVoice` can return is covered.
 */

type Engine = "kokoro" | "piper" | "supertonic";

const ORIGINAL_AUDIO = {
  defaultEngine: config.audio.defaultEngine,
  defaultVoice: config.audio.defaultVoice,
  supertonic: { ...config.audio.voices.supertonic },
};

afterEach(() => {
  config.audio.defaultEngine = ORIGINAL_AUDIO.defaultEngine;
  config.audio.defaultVoice = ORIGINAL_AUDIO.defaultVoice;
  config.audio.voices.supertonic = { ...ORIGINAL_AUDIO.supertonic };
  delete (audioGateway as Partial<typeof audioGateway>).voiceCatalog;
});

function apply(
  voices: { english: string; vietnamese: string },
  options: { defaultEngine: Engine; defaultVoice: string }
): { defaultEngine: Engine; defaultVoice: string } {
  config.audio.voices.supertonic = { ...voices };
  config.audio.defaultEngine = options.defaultEngine;
  config.audio.defaultVoice = options.defaultVoice;
  return options;
}

/** Run `body` with the gateway reporting `held` as the installed voices. */
async function withCatalog<T>(held: string[] | null, body: () => Promise<T>): Promise<T> {
  audioGateway.voiceCatalog = async () => held;
  return body();
}

describe("configuredSupertonicVoices", () => {
  it("returns both configured names when neither is empty", () => {
    const names = configuredSupertonicVoices(
      { english: "M1", vietnamese: "F2" },
      { defaultEngine: "piper", defaultVoice: "F1" }
    );

    assert.deepEqual(names.sort(), ["F2", "M1"]);
  });

  it("substitutes the default for an empty name, as resolveVoice does", () => {
    const names = configuredSupertonicVoices(
      { english: "M1", vietnamese: "" },
      { defaultEngine: "piper", defaultVoice: "F1" }
    );

    assert.ok(names.includes("F1"));
  });

  it("includes the default whenever the default engine is supertonic", () => {
    const names = configuredSupertonicVoices(
      { english: "M1", vietnamese: "F2" },
      { defaultEngine: "supertonic", defaultVoice: "F1" }
    );

    assert.ok(names.includes("F1"));
  });

  it("dedupes and drops whitespace-only names", () => {
    const names = configuredSupertonicVoices(
      { english: "M1", vietnamese: "M1" },
      { defaultEngine: "piper", defaultVoice: "   " }
    );

    assert.deepEqual(names, ["M1"]);
  });

  it("covers every voice resolveVoice can return for supertonic", () => {
    for (const defaultEngine of ["kokoro", "piper", "supertonic"] as Engine[]) {
      for (const english of ["M1", "", "  "]) {
        for (const vietnamese of ["F2", "", "  "]) {
          const options = apply(
            { english, vietnamese },
            { defaultEngine, defaultVoice: "F1" }
          );
          const covered = new Set(
            configuredSupertonicVoices(config.audio.voices.supertonic, options)
          );

          for (const language of ["english", "vietnamese"] as const) {
            const spoken = resolveVoice("supertonic", language);
            assert.ok(
              covered.has(spoken),
              `resolveVoice(${language}) => ${spoken} not covered (engine=${defaultEngine}, en=${JSON.stringify(english)}, vi=${JSON.stringify(vietnamese)})`
            );
          }
        }
      }
    }
  });
});

describe("unavailableVoices", () => {
  it("returns the names the service does not hold", () => {
    assert.deepEqual(unavailableVoices(["F1", "me", "M9"], ["F1", "M2"]), [
      "me",
      "M9",
    ]);
  });

  it("returns nothing when every name is held", () => {
    assert.deepEqual(unavailableVoices(["F1"], ["F1", "M2"]), []);
  });
});

describe("unavailableConfiguredVoices", () => {
  it("names a configured voice that holds no style", async () => {
    apply(
      { english: "me", vietnamese: "me" },
      { defaultEngine: "supertonic", defaultVoice: "F1" }
    );

    const unavailable = await withCatalog(["F1", "M1"], () =>
      unavailableConfiguredVoices()
    );

    assert.deepEqual(unavailable, ["me"]);
  });

  it("reports nothing when the service holds every configured voice", async () => {
    apply(
      { english: "F1", vietnamese: "F1" },
      { defaultEngine: "supertonic", defaultVoice: "F1" }
    );

    const unavailable = await withCatalog(["F1", "M1"], () =>
      unavailableConfiguredVoices()
    );

    assert.deepEqual(unavailable, []);
  });

  it("cannot tell when the gateway relays no catalog", async () => {
    apply(
      { english: "me", vietnamese: "me" },
      { defaultEngine: "supertonic", defaultVoice: "F1" }
    );

    const unavailable = await withCatalog(null, () =>
      unavailableConfiguredVoices()
    );

    // An unreachable audio stack is not a voice misconfiguration.
    assert.equal(unavailable, null);
  });
});

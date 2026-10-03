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

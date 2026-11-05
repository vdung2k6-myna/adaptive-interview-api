import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OFFLINE_F0_METHODS,
  effectiveVoiceConversion,
  parseVoiceConversionConfig,
} from "./voice-conversion-config";

describe("parseVoiceConversionConfig", () => {
  it("treats absent, null and empty as inherit", () => {
    assert.deepEqual(parseVoiceConversionConfig(undefined), { ok: true, value: undefined });
    assert.deepEqual(parseVoiceConversionConfig(null), { ok: true, value: undefined });
    assert.deepEqual(parseVoiceConversionConfig(""), { ok: true, value: undefined });
  });

  it("reads the bridge's JSON string and an object alike", () => {
    const fromString = parseVoiceConversionConfig('{"pitchShift":12,"formantShift":10}');
    const fromObject = parseVoiceConversionConfig({ pitchShift: 12, formantShift: 10 });

    assert.deepEqual(fromString, fromObject);
    assert.deepEqual(fromString, { ok: true, value: { pitchShift: 12, formantShift: 10 } });
  });

  it("reads the explicit opt-out as off", () => {
    assert.deepEqual(parseVoiceConversionConfig({ enabled: false }), { ok: true, value: false });
  });

  it("refuses malformed JSON and a non-object value", () => {
    assert.match((parseVoiceConversionConfig("not json") as { error: string }).error, /valid JSON/);
    assert.match((parseVoiceConversionConfig("[]") as { error: string }).error, /JSON object/);
    assert.match(
      (parseVoiceConversionConfig({ enabled: "no" }) as { error: string }).error,
      /enabled/
    );
  });

  it("clamps every bounded value to the service's range", () => {
    const parsed = parseVoiceConversionConfig({
      pitchShift: 99,
      formantShift: -99,
      indexRate: 2,
      protect: -1,
      rmsMixRate: 3,
      filterRadius: -4,
      crepeHopLength: 10,
    });

    assert.deepEqual(parsed, {
      ok: true,
      value: {
        pitchShift: 24,
        formantShift: -24,
        indexRate: 1,
        protect: 0,
        rmsMixRate: 1,
        filterRadius: 0,
        crepeHopLength: 64,
      },
    });
  });

  it("normalizes an F0 method and refuses one that is not advertised", () => {
    assert.deepEqual(parseVoiceConversionConfig({ f0Method: "RMVPE" }), {
      ok: true,
      value: { f0Method: "rmvpe" },
    });

    const refused = parseVoiceConversionConfig({ f0Method: "bogus" });
    assert.equal(refused.ok, false);
    assert.match((refused as { error: string }).error, /not one the conversion service advertises/);
    assert.ok((refused as { error: string }).error.includes(OFFLINE_F0_METHODS[0]));
  });

  it("refuses a field of the wrong type by name", () => {
    const parsed = parseVoiceConversionConfig({ pitchShift: "high" });
    assert.equal(parsed.ok, false);
    assert.match((parsed as { error: string }).error, /pitchShift/);
  });

  it("refuses an effects value that is not an object", () => {
    const parsed = parseVoiceConversionConfig({ effects: [] });
    assert.equal(parsed.ok, false);
    assert.match((parsed as { error: string }).error, /effects/);
  });
});

describe("effectiveVoiceConversion", () => {
  const NEUTRAL = { pitchShift: 0, formantShift: 0, f0Method: "" };
  const SHAPED = { pitchShift: 12, formantShift: 10, f0Method: "rmvpe" };

  it("keeps the deployment behaviour when the turn names nothing", () => {
    assert.equal(effectiveVoiceConversion(undefined, NEUTRAL), undefined);
    assert.deepEqual(effectiveVoiceConversion(undefined, SHAPED), {
      pitchShift: 12,
      formantShift: 10,
      f0Method: "rmvpe",
    });
  });

  it("passes the explicit opt-out through as off", () => {
    assert.equal(effectiveVoiceConversion(false, SHAPED), false);
  });

  it("fills an agent's unset options from the deployment and keeps its own", () => {
    assert.deepEqual(
      effectiveVoiceConversion({ pitchShift: 7, indexRate: 0.5 }, SHAPED),
      {
        pitchShift: 7,
        formantShift: 10,
        f0Method: "rmvpe",
        indexRate: 0.5,
      }
    );
  });

  it("carries an effects chain unchanged", () => {
    const effects = { reverb: { enabled: true, size: 0.3 } };
    const effective = effectiveVoiceConversion({ effects }, NEUTRAL);
    assert.deepEqual(effective, { pitchShift: 0, formantShift: 0, effects });
  });
});

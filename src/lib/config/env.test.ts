import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseGain, parseList, parsePositiveInt, parseUnitInterval } from "./env";

describe("parseList", () => {
  it("falls back when the variable is not set at all", () => {
    assert.deepEqual(parseList(undefined, ["a", "b"]), ["a", "b"]);
  });

  it("splits on commas and trims the values", () => {
    assert.deepEqual(parseList("one, two ,three", []), ["one", "two", "three"]);
  });

  it("reads a single value with no separator", () => {
    assert.deepEqual(parseList("truyen-kiem-hiep", []), ["truyen-kiem-hiep"]);
  });

  it("honours a variable set to blank as the empty list, not as the fallback", () => {
    // The distinction this parser exists for: an empty speakable-collection set
    // is a deployment that speaks no material at all, which is a decision an
    // operator may want to state rather than to inherit.
    assert.deepEqual(parseList("", ["a"]), []);
    assert.deepEqual(parseList("  ,  ", ["a"]), []);
  });
});

describe("parsePositiveInt", () => {
  it("reads a positive integer", () => {
    assert.equal(parsePositiveInt("12", 4), 12);
    assert.equal(parsePositiveInt("1", 4), 1, "one is a bound, not an absent one");
  });

  it("takes the fallback when the variable is unset or blank", () => {
    assert.equal(parsePositiveInt(undefined, 12), 12);
    assert.equal(parsePositiveInt("", 12), 12);
  });

  it("refuses zero and negative values rather than accepting them as a bound", () => {
    // A bound of zero is not "no bound" — it is a guard that admits nothing.
    // Reading it as a limit would disable the very thing the setting exists for.
    assert.equal(parsePositiveInt("0", 12), 12);
    assert.equal(parsePositiveInt("-3", 12), 12);
  });

  it("falls back for a value that is not a number", () => {
    assert.equal(parsePositiveInt("many", 12), 12);
    assert.equal(parsePositiveInt("1.5", 12), 1, "the integer part is read, as parseInt does");
  });
});

describe("parseUnitInterval", () => {
  it("reads a value inside the interval", () => {
    assert.equal(parseUnitInterval("0.62", 0.55), 0.62);
  });

  it("allows both ends of the interval", () => {
    assert.equal(parseUnitInterval("0", 0.55), 0, "speaking any hit is a choice an operator may make");
    assert.equal(parseUnitInterval("1", 0.55), 1);
  });

  it("falls back for a value outside the interval rather than clamping it", () => {
    // Clamping `2` would silently turn it into "refuse every hit", which is not
    // what the operator who wrote `2` was asking for and is the opposite of what
    // the value looks like it means.
    assert.equal(parseUnitInterval("2", 0.55), 0.55);
    assert.equal(parseUnitInterval("-0.1", 0.55), 0.55);
  });

  it("falls back for a value that is not a number", () => {
    assert.equal(parseUnitInterval(undefined, 0.55), 0.55);
    assert.equal(parseUnitInterval("", 0.55), 0.55);
    assert.equal(parseUnitInterval("high", 0.55), 0.55);
  });
});

describe("parseGain", () => {
  it("reads a gain in either direction from 1", () => {
    assert.equal(parseGain("0.5", 1.2), 0.5, "a fractional gain must not be read as an integer");
    assert.equal(parseGain("1.2", 0.5), 1.2, "amplifying is the reason there is no upper bound");
  });

  it("allows a gain of exactly 1 and of exactly 0", () => {
    assert.equal(parseGain("1", 0.5), 1, "1 is the neutral value, not a missing one");
    assert.equal(parseGain("0", 0.5), 0, "muting an engine is a real choice");
  });

  it("falls back for a negative gain instead of clamping it to zero", () => {
    // Clamping to 0 would mute the engine; a negative multiplier inverts the
    // waveform's phase, which is audible and is nobody's intent when they meant
    // to type a volume.
    assert.equal(parseGain("-0.5", 0.7), 0.7);
  });

  it("falls back for a value that is not a number", () => {
    assert.equal(parseGain(undefined, 1), 1);
    assert.equal(parseGain("", 1), 1);
    assert.equal(parseGain("loud", 1), 1);
    assert.equal(parseGain("Infinity", 1), 1);
  });
});

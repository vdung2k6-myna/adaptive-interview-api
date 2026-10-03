import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseList, parseUnitInterval } from "./env";

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

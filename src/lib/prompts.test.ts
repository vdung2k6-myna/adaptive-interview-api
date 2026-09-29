import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trimTurnMessages } from "./prompts";
import type { OllamaMessage } from "./ollama";

/**
 * The trim's arithmetic, at the boundaries its budget has.
 *
 * This function had no test, which is why its accumulator could measure the
 * whole middle against the budget for as long as it did. The result was a cliff
 * rather than a bound: the moment a history went over budget the two ends were
 * returned and everything between them dropped, spending a fraction of the
 * budget that was supposed to be spent. A 40-message history of 1,000-character
 * turns came back as 2 messages and 2,000 characters of its 24,000.
 *
 * Each `describe` below is one of the bound's scenarios. The two measured cases
 * in the second one are pinned as expectations rather than recomputed, because
 * their counts are what the fix was designed against.
 */

/** A history of `sizes.length` turns, the i-th exactly `sizes[i]` characters
 * long. Roles alternate the way an interview's do, and each turn's content opens
 * with its own index, so a retained turn can be identified by position. */
function history(sizes: number[]): OllamaMessage[] {
  return sizes.map((size, i) => ({
    role: i % 2 === 0 ? "assistant" : "user",
    content: `${i}:`.padEnd(size, "x").slice(0, size),
  }));
}

function totalChars(messages: OllamaMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

describe("trimTurnMessages: history within the budget is included unchanged", () => {
  it("returns every message, in order, when the history is under the budget", () => {
    const turns = history([10, 20, 30, 40]);

    assert.deepEqual(trimTurnMessages(turns, 500), turns, "every message, in order");
  });

  it("returns the history unchanged when it sits exactly at the budget", () => {
    const turns = history([10, 20, 30, 40]); // 100 characters

    assert.deepEqual(trimTurnMessages(turns, 100), turns, "at the budget is within it");
  });
});

describe("trimTurnMessages: history over the budget keeps its most recent turns", () => {
  it("drops one message rather than the whole middle when it is one character over", () => {
    const turns = history([10, 51, 30, 10]); // 101 characters, budget 100

    const result = trimTurnMessages(turns, 100);

    // The assertion is on the shape of the result rather than on which message
    // survived, because the count is what was broken: the old arithmetic returned
    // the two ends here — 2 messages and 20 characters of a 100-character budget.
    assert.equal(result.length, 3, "one message dropped, not everything between the ends");
    // The total also says *which* middle turn was kept: the newest fits in what the
    // two ends left (80 characters), and the older one does not, so the retained
    // middle is the 30 and not the 51.
    assert.equal(totalChars(result), 50, "10 + 30 + 10, and the 51 discarded");
  });

  it("keeps the newest 22 of 38 middle turns in a 40-message history", () => {
    // The cliff from the proposal: uniform turns make the count exact, and the
    // old arithmetic returned 2 messages here.
    const turns = history(new Array(40).fill(1_000));

    const result = trimTurnMessages(turns, 24_000);

    assert.equal(result.length, 24, "the two ends plus the 22 newest middle turns");
    assert.equal(totalChars(result), 24_000, "the budget is spent, not approximated");
  });

  it("keeps the recent tail of a 16-exchange interview of short questions and long answers", () => {
    // The shape the budget is really for: 150-character questions and
    // 2,000-character answers. A forward walk over the same 30 middle turns would
    // keep 20 of them rather than 21 and stop at 23,650 characters, so this pins
    // the newest-first order as well as the count — and it pins the two ends as
    // charged against the budget, which is what leaves the middle 21,850.
    const exchange = [150, 2_000];
    const turns = history(Array.from({ length: 32 }, (_, i) => exchange[i % 2]));

    const result = trimTurnMessages(turns, 24_000);

    assert.equal(result.length, 23, "the two ends plus 21 middle turns");
    assert.equal(totalChars(result), 23_800, "what the two ends left for the middle");
  });
});

describe("trimTurnMessages: the two ends and the floor", () => {
  it("keeps the oldest turn in an over-budget history", () => {
    const turns = history([1_000, 1_000, 1_000, 1_000, 1_000]); // 5,000, budget 3,000

    const result = trimTurnMessages(turns, 3_000);

    assert.equal(result[0].content, turns[0].content, "the oldest turn survives");
    assert.ok(result.length > 2, "and it is not alone with the newest");
  });

  it("returns both ends and no middle when the ends alone exceed the budget", () => {
    const turns = history([20_000, 40, 40, 20_000]);

    const result = trimTurnMessages(turns, 24_000);

    assert.deepEqual(
      result,
      [turns[0], turns[3]],
      "both ends, and nothing between them"
    );
    assert.ok(
      totalChars(result) > 24_000,
      "the budget is exceeded rather than either end dropped — a turn with no history is worse"
    );
  });

  it("returns a two-message history unchanged however large those two messages are", () => {
    const turns = history([20_000, 20_000]);

    assert.deepEqual(trimTurnMessages(turns, 1_000), turns, "there is no middle to drop");
  });
});

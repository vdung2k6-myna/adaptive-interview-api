import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { createTurnTranscriptStore, readTurnId, type TurnKey } from "./turn-transcript";

const KEY: TurnKey = { turnId: "turn-0001", sessionId: "session-0001" };

describe("readTurnId", () => {
  it("accepts the identifiers a client can invent and refuses anything else", () => {
    assert.equal(readTurnId("8f14e45f-ea4a-4c1e-9c3d-1a2b3c4d5e6f"), "8f14e45f-ea4a-4c1e-9c3d-1a2b3c4d5e6f");
    assert.equal(readTurnId("turn_0001-A"), "turn_0001-A");
    assert.equal(readTurnId(""), "");
    assert.equal(readTurnId(undefined), "");
    assert.equal(readTurnId("short"), "", "too short to be an identifier");
    assert.equal(readTurnId("has a space"), "");
    assert.equal(readTurnId("../escape"), "");
  });
});

describe("a turn's windowed transcript", () => {
  it("answers with every window's text and PCM, in the order they arrived", async () => {
    const store = createTurnTranscriptStore();

    await store.appendWindow(KEY, 0, " Hello there. ", Buffer.from([1, 2]));
    await store.appendWindow(KEY, 1, " Second window.", Buffer.from([3]));

    const claim = await store.claim(KEY);
    assert.ok(claim, "a turn with windows is claimable");
    assert.deepEqual(claim.outcome, { ok: true, text: "Hello there. Second window." });
    assert.equal(claim.pcmBytes, 3);
    assert.deepEqual([...(await readFile(claim.pcmPath))], [1, 2, 3]);

    await store.discard(claim);
    await assert.rejects(stat(claim.pcmPath), "the PCM is gone once the turn has it");
  });

  it("is claimed once", async () => {
    const store = createTurnTranscriptStore();
    await store.appendWindow(KEY, 0, "Only once.", Buffer.from("x"));

    const first = await store.claim(KEY);
    assert.ok(first);
    await store.discard(first);

    assert.equal(await store.claim(KEY), null, "a second claim finds nothing");
  });

  it("knows no turn it was never given a window for", async () => {
    const store = createTurnTranscriptStore();
    assert.equal(await store.claim({ turnId: "never-sent" }), null);
  });

  it("keeps two sessions' turns apart even when the ids match", async () => {
    const store = createTurnTranscriptStore();
    await store.appendWindow({ turnId: "same", sessionId: "a" }, 0, "From A.", Buffer.from("a"));
    await store.appendWindow({ turnId: "same", sessionId: "b" }, 0, "From B.", Buffer.from("b"));

    const a = await store.claim({ turnId: "same", sessionId: "a" });
    const b = await store.claim({ turnId: "same", sessionId: "b" });

    assert.deepEqual(a?.outcome, { ok: true, text: "From A." });
    assert.deepEqual(b?.outcome, { ok: true, text: "From B." });
    await store.discard(a!);
    await store.discard(b!);
  });

  it("reports a window that could not be transcribed rather than a shorter answer", async () => {
    const store = createTurnTranscriptStore();
    await store.appendWindow(KEY, 0, "The first part.", Buffer.from("a"));
    await store.fail(KEY, 1, "Part of the answer could not be transcribed.");

    const claim = await store.claim(KEY);
    assert.ok(claim);
    assert.deepEqual(claim.outcome, {
      ok: false,
      message: "Part of the answer could not be transcribed.",
    });
    await store.discard(claim);
  });

  it("forgets a turn older than its bound, and takes its PCM with it", async () => {
    let now = 1_000;
    const store = createTurnTranscriptStore({ retentionMs: 50, now: () => now });

    await store.appendWindow(KEY, 0, "Too late.", Buffer.from("old"));
    const held = store.size();
    assert.equal(held, 1);

    now += 100;

    assert.equal(await store.claim(KEY), null, "an expired turn is not answerable");
    assert.equal(store.size(), 0, "and it is no longer held");
  });

  it("sweeps turns nobody claimed", async () => {
    let now = 1_000;
    const store = createTurnTranscriptStore({ retentionMs: 50, now: () => now });

    await store.appendWindow(KEY, 0, "Abandoned.", Buffer.from("a"));
    now += 100;

    await store.sweep();
    assert.equal(store.size(), 0);
    assert.equal(await store.claim(KEY), null);
  });
});

describe("a window sent more than once", () => {
  it("is taken once — its text and audio are not counted twice", async () => {
    const store = createTurnTranscriptStore();

    await store.appendWindow(KEY, 0, "First window.", Buffer.from([1, 2]));
    await store.appendWindow(KEY, 0, "First window.", Buffer.from([1, 2]));
    await store.appendWindow(KEY, 1, "Second window.", Buffer.from([3]));

    const claim = await store.claim(KEY);
    assert.ok(claim);
    assert.deepEqual(claim.outcome, { ok: true, text: "First window. Second window." });
    assert.equal(claim.pcmBytes, 3, "the retry added no audio");
    assert.deepEqual([...(await readFile(claim.pcmPath))], [1, 2, 3]);
    await store.discard(claim);
  });

  it("clears the failure recorded for it when the retry arrives", async () => {
    const store = createTurnTranscriptStore();

    await store.appendWindow(KEY, 0, "Heard before.", Buffer.from([1]));
    await store.fail(KEY, 1, "Part of the answer could not be transcribed.");
    // The client's retry of window 1 — the refusal was transient.
    await store.appendWindow(KEY, 1, "Heard on the retry.", Buffer.from([2]));

    const claim = await store.claim(KEY);
    assert.ok(claim);
    assert.deepEqual(claim.outcome, { ok: true, text: "Heard before. Heard on the retry." });
    await store.discard(claim);
  });

  it("still fails when the retry for that window never arrives", async () => {
    const store = createTurnTranscriptStore();
    await store.appendWindow(KEY, 0, "Heard before.", Buffer.from([1]));
    await store.fail(KEY, 1, "Part of the answer could not be transcribed.");

    const claim = await store.claim(KEY);
    assert.ok(claim);
    assert.deepEqual(claim.outcome, {
      ok: false,
      message: "Part of the answer could not be transcribed.",
    });
    await store.discard(claim);
  });
});

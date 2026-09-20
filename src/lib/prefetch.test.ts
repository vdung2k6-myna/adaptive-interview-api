import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPrefetchStore, type PrefetchStore } from "./prefetch";
import type { KnowledgeChunk, KnowledgeSearchOutcome } from "./knowledge";

const CHUNKS: KnowledgeChunk[] = [{ text: "a chunk", source: "guide.pdf" }];

interface SearchCall {
  query: string;
  topK?: number;
  collections?: string[];
}

function storeReturning(outcome: KnowledgeSearchOutcome) {
  const calls: SearchCall[] = [];
  const store = createPrefetchStore({
    search: async (query, topK, collections) => {
      calls.push({ query, topK, collections });
      return outcome;
    },
  });
  return { store, calls };
}

/**
 * The type-level half of this task: `claim` is declared to hand back chunks or
 * nothing, so an `{ ok: false }` outcome is unrepresentable as a held value —
 * which is what makes it impossible to serve a refusal later as a retrieval.
 * If `claim` ever widens to the outcome type, the `never` branch below stops
 * compiling.
 */
type ClaimResult = ReturnType<PrefetchStore["claim"]>;
const claimReturnsChunksOrNull: ClaimResult extends KnowledgeChunk[] | null ? true : never = true;

describe("createPrefetchStore", () => {
  it("holds a result and identifies it for reuse", async () => {
    const { store } = storeReturning({ ok: true, chunks: CHUNKS });

    const id = await store.issue("what is the best sword technique", ["truyen-kiem-hiep"]);

    assert.ok(id, "a successful prefetch must be identified");
    assert.equal(store.size(), 1);
    assert.deepEqual(store.claim(id, "what is the best sword technique"), CHUNKS);
  });

  it("runs the scoped search it was asked for", async () => {
    const { store, calls } = storeReturning({ ok: true, chunks: [] });

    await store.issue("kiem hiep", ["truyen-kiem-hiep"]);

    assert.deepEqual(calls, [
      { query: "kiem hiep", topK: 3, collections: ["truyen-kiem-hiep"] },
    ]);
  });

  it("holds an empty successful result, because an empty result is an answer", async () => {
    const { store } = storeReturning({ ok: true, chunks: [] });

    const id = await store.issue("nothing in scope is relevant", ["truyen-kiem-hiep"]);

    assert.ok(id, "an empty answer is not a failure (D5)");
    assert.deepEqual(store.claim(id, "nothing in scope is relevant"), []);
  });

  it("holds nothing and returns no id for any failure reason", async () => {
    for (const reason of ["timeout", "unreachable", "server_error", "rejected"] as const) {
      const { store } = storeReturning({ ok: false, reason });

      const id = await store.issue("kiem hiep", ["truyen-kiem-hiep"]);

      assert.equal(id, null, `a ${reason} must never be identified for reuse`);
      assert.equal(store.size(), 0, `a ${reason} must hold nothing`);
    }
  });

  it("is single-use, so a second claim of one id returns nothing", async () => {
    const { store } = storeReturning({ ok: true, chunks: CHUNKS });
    const id = (await store.issue("kiem hiep", [])) as string;

    assert.deepEqual(store.claim(id, "kiem hiep"), CHUNKS);
    assert.equal(store.claim(id, "kiem hiep"), null, "a prefetch belongs to one turn (D1)");
  });

  it("discards a prefetch whose input differs, and does not keep it for the original", async () => {
    const { store } = storeReturning({ ok: true, chunks: CHUNKS });
    const id = (await store.issue("kiem hiep", [])) as string;

    assert.equal(store.claim(id, "kiem hiep hay nhat"), null);
    assert.equal(store.size(), 0, "a mismatch discards the hold (D2)");
    assert.equal(store.claim(id, "kiem hiep"), null, "and it does not come back");
  });

  it("returns nothing for an id it never issued", () => {
    const { store } = storeReturning({ ok: true, chunks: CHUNKS });

    assert.equal(store.claim("no-such-id", "anything"), null);
    assert.equal(claimReturnsChunksOrNull, true);
  });
});

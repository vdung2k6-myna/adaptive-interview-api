import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionKnowledge, type SessionKnowledge } from "./session-knowledge";
import type { KnowledgeChunk, KnowledgeSearchOutcome } from "./knowledge";

const CHUNKS: KnowledgeChunk[] = [{ text: "a chunk", source: "guide.pdf" }];
const OTHER: KnowledgeChunk[] = [{ text: "another chunk", source: "other.pdf" }];

interface SearchCall {
  query: string;
  topK?: number;
  collections?: string[];
}

interface Fake {
  store: SessionKnowledge;
  calls: SearchCall[];
}

/**
 * A session knowledge store over a fake search. `settles` false makes every
 * search hang, which is the case 4.1's proof rests on.
 */
function storeReturning(
  outcome: KnowledgeSearchOutcome | ((call: SearchCall) => KnowledgeSearchOutcome),
  options: { settles?: boolean } = {}
): Fake {
  const calls: SearchCall[] = [];
  const store = createSessionKnowledge({
    search: async (query, topK, collections) => {
      const call = { query, topK, collections };
      calls.push(call);
      if (options.settles === false) {
        return new Promise<KnowledgeSearchOutcome>(() => {});
      }
      return typeof outcome === "function" ? outcome(call) : outcome;
    },
  });
  return { store, calls };
}

/** Let the store's un-awaited search settle before asserting on its chunks. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("createSessionKnowledge — the session's topic-scoped hold", () => {
  it("issues one search per scope and serves that hold", async () => {
    const { store, calls } = storeReturning({ ok: true, chunks: CHUNKS });

    assert.equal(store.ensure(["truyen-kiem-hiep"], "Truyện kiếm hiệp"), true);
    await settled();
    assert.equal(store.ensure(["truyen-kiem-hiep"], "Truyện kiếm hiệp"), false);

    assert.equal(calls.length, 1, "a second ensure for the same scope must not search again");
    assert.equal(calls[0].query, "Truyện kiếm hiệp");
    assert.deepEqual(calls[0].collections, ["truyen-kiem-hiep"]);
    assert.deepEqual(store.chunksFor(["truyen-kiem-hiep"]), CHUNKS);
  });

  it("does not serve a hold issued for a different scope", async () => {
    const { store } = storeReturning({ ok: true, chunks: CHUNKS });

    store.ensure(["truyen-kiem-hiep"], "Truyện kiếm hiệp");
    await settled();

    assert.deepEqual(
      store.chunksFor(["kiem-hiep"]),
      [],
      "a turn whose collections differ from the ones the search was issued for gets nothing"
    );
  });

  it("serves the same scope regardless of the order its names arrive in", async () => {
    const { store } = storeReturning({ ok: true, chunks: CHUNKS });

    store.ensure(["truyen-kiem-hiep", "kiem-hiep"], "both");
    await settled();

    assert.deepEqual(store.chunksFor(["kiem-hiep", "truyen-kiem-hiep"]), CHUNKS);
    assert.deepEqual(store.chunksFor(["kiem-hiep"]), [], "but a subset is a different scope");
  });

  it("returns before the search settles and holds nothing until it does", async () => {
    const { store, calls } = storeReturning({ ok: true, chunks: CHUNKS }, { settles: false });

    assert.equal(
      store.ensure(["truyen-kiem-hiep"], "Truyện kiếm hiệp"),
      true,
      "ensure must return without waiting for the search"
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(store.chunksFor(["truyen-kiem-hiep"]), []);
    assert.equal(store.size(), 0);
  });

  it("holds no chunks for a search that did not yield a result", async () => {
    for (const reason of ["timeout", "unreachable", "server_error", "rejected"] as const) {
      const { store } = storeReturning({ ok: false, reason });

      store.ensure(["truyen-kiem-hiep"], "Truyện kiếm hiệp");
      await settled();

      assert.deepEqual(store.chunksFor(["truyen-kiem-hiep"]), [], `nothing for ${reason}`);
      assert.equal(store.size(), 0);
    }
  });

  it("holds an empty successful result as no chunks", async () => {
    const { store } = storeReturning({ ok: true, chunks: [] });

    store.ensure(["truyen-kiem-hiep"], "Truyện kiếm hiệp");
    await settled();

    assert.deepEqual(store.chunksFor(["truyen-kiem-hiep"]), [], "an empty answer is no fallback");
    assert.equal(store.size(), 0);
  });

  it("issues nothing for an empty scope or a whitespace-only query", () => {
    const { store, calls } = storeReturning({ ok: true, chunks: CHUNKS });

    assert.equal(store.ensure([], "Truyện kiếm hiệp"), false, "no scope, no search");
    assert.equal(store.ensure(["truyen-kiem-hiep"], "   "), false, "no usable query, no search");

    assert.equal(calls.length, 0, "doc-etl-api rejects both, so neither is worth issuing");
  });

  it("replaces the hold when a new session opens on a different scope", async () => {
    const { store, calls } = storeReturning((call) =>
      call.collections?.[0] === "truyen-kiem-hiep"
        ? { ok: true, chunks: CHUNKS }
        : { ok: true, chunks: OTHER }
    );

    store.ensure(["truyen-kiem-hiep"], "Truyện kiếm hiệp");
    await settled();
    store.ensure(["kiem-hiep"], "Kiếm hiệp");
    await settled();

    assert.equal(calls.length, 2, "a different scope is a different session's worth of scope");
    assert.deepEqual(store.chunksFor(["kiem-hiep"]), OTHER, "the newer hold is the one served");
    assert.deepEqual(store.chunksFor(["truyen-kiem-hiep"]), [], "and the older one is gone");
  });
});

import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { searchKnowledge } from "./knowledge";

/**
 * Replace global fetch with one canned response. These tests never touch a live
 * doc-etl-api — the whole point is to pin the /search contract offline, so a
 * change to the field names fails here instead of in a prompt at runtime.
 */
function stubFetch(status: number, body: unknown): void {
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("searchKnowledge", () => {
  afterEach(() => mock.restoreAll());

  it("maps the server's source_name onto the chunk source", async () => {
    stubFetch(200, {
      results: [
        { text: "The STAR method structures answers.", score: 0.91, source_name: "interview-guide.pdf" },
      ],
    });

    const chunks = await searchKnowledge("star method", 1);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].source, "interview-guide.pdf");
  });

  it("warns instead of substituting a value when source_name is absent", async () => {
    const warnings: string[] = [];
    mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    stubFetch(200, { results: [{ text: "An unattributable chunk.", score: 0.4 }] });

    const chunks = await searchKnowledge("orphan", 1);

    assert.equal(chunks[0].source, "", "must not invent a placeholder source");
    assert.ok(
      warnings.some((w) => w.includes("source_name")),
      `expected a warning naming source_name, got ${JSON.stringify(warnings)}`
    );
  });

  it("returns an empty array when the service responds with an error", async () => {
    mock.method(console, "warn", () => {});
    stubFetch(500, { detail: "boom" });

    assert.deepEqual(await searchKnowledge("star method", 1), []);
  });

  it("returns an empty array when the response carries no results", async () => {
    stubFetch(200, {});

    assert.deepEqual(await searchKnowledge("star method", 1), []);
  });
});

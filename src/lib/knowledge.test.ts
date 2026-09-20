import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { searchKnowledge, type KnowledgeSearchOutcome } from "./knowledge";
import { buildVoiceAgentPrompt } from "./prompts";

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

/** A response whose body is not JSON at all. */
function stubRawFetch(status: number, rawBody: string): void {
  mock.method(globalThis, "fetch", async () =>
    new Response(rawBody, { status, headers: { "Content-Type": "application/json" } })
  );
}

/** A fetch that rejects, the way a network failure does. */
function stubRejectingFetch(err: Error): void {
  mock.method(globalThis, "fetch", async () => {
    throw err;
  });
}

/** Silence warnings and hand back what was warned, for the noisy outcomes. */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.join(" "));
  });
  return warnings;
}

/** Fail loudly rather than reading `.chunks` off a failure outcome. */
function expectOk(outcome: KnowledgeSearchOutcome) {
  assert.ok(outcome.ok, `expected a result, got ${JSON.stringify(outcome)}`);
  return outcome.chunks;
}

describe("searchKnowledge", () => {
  afterEach(() => mock.restoreAll());

  it("maps the server's source_name onto the chunk source", async () => {
    stubFetch(200, {
      results: [
        { text: "The STAR method structures answers.", score: 0.91, source_name: "interview-guide.pdf" },
      ],
    });

    const chunks = expectOk(await searchKnowledge("star method", 1));

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].source, "interview-guide.pdf");
  });

  it("warns instead of substituting a value when source_name is absent", async () => {
    const warnings = captureWarnings();
    stubFetch(200, { results: [{ text: "An unattributable chunk.", score: 0.4 }] });

    const chunks = expectOk(await searchKnowledge("orphan", 1));

    assert.equal(chunks[0].source, "", "must not invent a placeholder source");
    assert.ok(
      warnings.some((w) => w.includes("source_name")),
      `expected a warning naming source_name, got ${JSON.stringify(warnings)}`
    );
  });

  /* ── the four failure reasons, one test each ─────────────────────── */

  it("reports a 5xx as server_error, a failure the fallback may answer", async () => {
    captureWarnings();
    stubFetch(500, { detail: "boom" });

    assert.deepEqual(await searchKnowledge("star method", 1), {
      ok: false,
      reason: "server_error",
    });
  });

  it("reports an unreachable service as unreachable", async () => {
    captureWarnings();
    stubRejectingFetch(new Error("fetch failed"));

    assert.deepEqual(await searchKnowledge("star method", 1), {
      ok: false,
      reason: "unreachable",
    });
  });

  it("reports our own timeout as timeout", async () => {
    captureWarnings();
    const aborted = new Error("This operation was aborted");
    aborted.name = "AbortError";
    stubRejectingFetch(aborted);

    assert.deepEqual(await searchKnowledge("star method", 1), {
      ok: false,
      reason: "timeout",
    });
  });

  it("reports a body that is not JSON as server_error", async () => {
    captureWarnings();
    stubRawFetch(200, "<html>not json</html>");

    assert.deepEqual(await searchKnowledge("star method", 1), {
      ok: false,
      reason: "server_error",
    });
  });

  it("reports a non-array results field as server_error, not as an empty answer", async () => {
    captureWarnings();
    stubFetch(200, { results: "nope" });

    assert.deepEqual(await searchKnowledge("star method", 1), {
      ok: false,
      reason: "server_error",
    });
  });

  it("reports a 400 as a refusal and logs the service's own message", async () => {
    const warnings = captureWarnings();
    stubFetch(400, { detail: "Invalid collection name: 'Truyện kiếm hiệp'" });

    assert.deepEqual(await searchKnowledge("star method", 1, ["bad name"]), {
      ok: false,
      reason: "rejected",
    });
    assert.ok(
      warnings.some((w) => w.includes("Invalid collection name: 'Truyện kiếm hiệp'")),
      `a refusal must carry the service's message, got ${JSON.stringify(warnings)}`
    );
    assert.ok(
      warnings.some((w) => w.includes("refused")),
      `a refusal must be logged distinguishably from a failure, got ${JSON.stringify(warnings)}`
    );
  });

  it("reports a 422 as a refusal", async () => {
    captureWarnings();
    stubFetch(422, { detail: [{ loc: ["body", "top_k"], msg: "must be <= 100" }] });

    assert.deepEqual(await searchKnowledge("star method", 99), {
      ok: false,
      reason: "rejected",
    });
  });

  /* ── a result is a result, including an empty one ────────────────── */

  it("reports a 200 carrying no results as a successful empty answer", async () => {
    stubFetch(200, {});

    const outcome = await searchKnowledge("star method", 1);

    assert.deepEqual(outcome, { ok: true, chunks: [] });
  });

  it("returns no chunks for a collection nothing belongs to, and no knowledge section", async () => {
    stubFetch(200, { results: [] });

    const outcome = await searchKnowledge("truyen kiem hiep hay nhat", 3, [
      "khong-co-gi-trong-day",
    ]);
    const chunks = expectOk(outcome);
    const prompt = buildVoiceAgentPrompt(
      "You are a friendly tutor.",
      "english",
      [],
      chunks.length ? chunks : undefined
    );

    assert.deepEqual(chunks, [], "an out-of-corpus scope is an empty result, not an error");
    assert.ok(
      !prompt.some((m) => m.content.includes("Relevant knowledge:")),
      `an empty result must add no knowledge section; got ${JSON.stringify(prompt)}`
    );
  });

  /* ── the request body ────────────────────────────────────────────── */

  function captureRequestBody(): Record<string, unknown>[] {
    const sent: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (...args: unknown[]) => {
      const init = args[1] as { body?: string } | undefined;
      sent.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    return sent;
  }

  it("sends collections on the request body when asked to scope", async () => {
    const sent = captureRequestBody();

    await searchKnowledge("kiem hiep", 3, ["truyen-kiem-hiep"]);

    assert.deepEqual(sent[0].collections, ["truyen-kiem-hiep"]);
  });

  it("omits collections rather than sending an empty filter", async () => {
    const sent = captureRequestBody();

    await searchKnowledge("kiem hiep", 3, []);

    assert.ok(
      !("collections" in sent[0]),
      `an empty filter is a 400 in doc-etl-api; got ${JSON.stringify(sent[0])}`
    );
  });

  it("sends no collections field when the caller asks for none", async () => {
    const sent = captureRequestBody();

    await searchKnowledge("star method", 1);

    assert.equal(sent.length, 1, "expected exactly one request");
    assert.ok(
      !("collections" in sent[0]),
      `an unscoped search must stay today's request; got ${JSON.stringify(sent[0])}`
    );
    assert.deepEqual(Object.keys(sent[0]).sort(), ["query", "top_k"]);
  });
});

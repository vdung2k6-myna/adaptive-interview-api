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

  /* ── the routing metadata a hit needs to locate its own source ───── */

  it("carries a hit's address, collections, position and score through the parse", async () => {
    const address = "https%3A%2F%2Fvi.wikipedia.org%2Fwiki%2FTr%E1%BA%A1ng_Qu%E1%BB%B3nh";
    stubFetch(200, {
      results: [
        {
          text: "Trạng Quỳnh là một nhân vật truyện cười dân gian.",
          score: 0.68,
          source_name: "Trạng Quỳnh – Wikipedia",
          address,
          collections: ["truyen-kiem-hiep", "kiem-hiep"],
          position: 7,
        },
      ],
    });

    const chunks = expectOk(await searchKnowledge("Trạng Quỳnh", 1));

    assert.deepEqual(chunks[0], {
      text: "Trạng Quỳnh là một nhân vật truyện cười dân gian.",
      source: "Trạng Quỳnh – Wikipedia",
      score: 0.68,
      address,
      collections: ["truyen-kiem-hiep", "kiem-hiep"],
      position: 7,
      section: undefined,
    });
  });

  it("carries a hit's section through the parse as one text with its range and length", async () => {
    // The section is one object now: the source's own text over the run, the range
    // it was sliced from, and the length the whole section holds. The gate decides
    // completeness on `end - start` against `size`, so all four fields have to
    // survive the parse together.
    stubFetch(200, {
      results: [
        {
          text: "## SÚNG SĂN\nMột người thợ săn nọ...",
          score: 0.71,
          source_name: "101-Truyen-Cuoi-Dan-Gian-Viet-Nam.txt",
          address: "101-Truyen-Cuoi-Dan-Gian-Viet-Nam.txt",
          collections: ["truyen-cuoi"],
          position: 14,
          section: {
            text: "## SÚNG SĂN\nMột người thợ săn nọ...\n\n...bèn bắn vào bụi rậm.",
            start: 1200,
            end: 1260,
            size: 60,
          },
        },
      ],
    });

    const chunks = expectOk(
      await searchKnowledge("súng săn", 1, ["truyen-cuoi"], { expand: "section" })
    );

    assert.deepEqual(chunks[0].section, {
      text: "## SÚNG SĂN\nMột người thợ săn nọ...\n\n...bèn bắn vào bụi rậm.",
      start: 1200,
      end: 1260,
      size: 60,
    });
  });

  it("carries a bounded expansion's stated length rather than reading it off the text", async () => {
    // A bounded expansion: the text is the window the cap allowed, `size` is the
    // whole section. Reading the length off the text received would report this as
    // a complete section, which is what makes the two numbers separate facts — and
    // what the gate's `end - start === size` is asked.
    stubFetch(200, {
      results: [
        {
          text: "## Chiêu thức\nChiêu thứ nhất...",
          score: 0.64,
          source_name: "kiem-hiep.txt",
          section: {
            text: "## Chiêu thức\nChiêu thứ nhất...",
            start: 900,
            end: 931,
            size: 4200,
          },
        },
      ],
    });

    const chunks = expectOk(await searchKnowledge("chiêu thức", 1));
    const section = chunks[0].section;

    assert.equal(section?.size, 4200, "the size is the service's, not the text's");
    assert.notEqual(
      (section?.end ?? 0) - (section?.start ?? 0),
      section?.size,
      "and it is larger than the window the text occupies, so the passage is refused"
    );
  });

  it("reads a section that arrived as the older chunk list as no section at all", async () => {
    // The shape the service returned before this change: a list of chunks. There is
    // no passage in it to speak, so it is read as absent — and said out loud, since
    // a shape this client cannot read is a contract mismatch rather than a service
    // that chose to send no section.
    const warnings = captureWarnings();
    stubFetch(200, {
      results: [
        {
          text: "## SÚNG SĂN\nMột người thợ săn nọ...",
          score: 0.71,
          source_name: "101-Truyen-Cuoi-Dan-Gian-Viet-Nam.txt",
          section: [{ text: "## SÚNG SĂN\nMột người thợ săn nọ...", position: 14 }],
        },
      ],
    });

    const chunks = expectOk(await searchKnowledge("súng săn", 1));

    assert.equal(chunks[0].section, undefined);
    assert.ok(
      warnings.some((w) => w.includes("section")),
      `expected a warning naming the section, got ${JSON.stringify(warnings)}`
    );
  });

  it("reads a section missing one of its numbers as no section at all", async () => {
    // Without `size` the passage cannot be known to be whole, and without its range
    // it cannot say where its text came from — so the object is not a section this
    // client can gate on, whatever text it carries.
    const warnings = captureWarnings();
    stubFetch(200, {
      results: [
        {
          text: "## Chiêu thức\nChiêu thứ nhất...",
          score: 0.64,
          source_name: "kiem-hiep.txt",
          section: { text: "## Chiêu thức\nChiêu thứ nhất...", start: 40, end: 71 },
        },
      ],
    });

    const chunks = expectOk(await searchKnowledge("chiêu thức", 1));

    assert.equal(chunks[0].section, undefined);
    assert.ok(warnings.some((w) => w.includes("section")));
  });

  it("keeps a section whose text is empty apart from a hit that carries none", async () => {
    // The distinction the object shape makes: an absent section is a hit with
    // nothing to speak, while a present section with an empty `text` is a section
    // that holds no words. Only the first is the gate's to refuse; the second is
    // the reply's, and the two reasons are logged apart.
    stubFetch(200, {
      results: [
        {
          text: "A chunk of a passage holding no words.",
          score: 0.66,
          source_name: "guide.pdf",
          section: { text: "", start: 10, end: 10, size: 0 },
        },
      ],
    });

    const chunks = expectOk(await searchKnowledge("empty", 1));

    assert.deepEqual(chunks[0].section, { text: "", start: 10, end: 10, size: 0 });
  });

  it("reads a null section as no section, and not as drift", async () => {
    // What the service answers for a source indexed before ranges existed: it chose
    // to send no section, which is the ordinary answer rather than a contract this
    // client cannot read.
    const warnings = captureWarnings();
    stubFetch(200, {
      results: [
        {
          text: "A chunk of a source without ranges.",
          score: 0.66,
          source_name: "guide.pdf",
          section: null,
        },
      ],
    });

    const chunks = expectOk(await searchKnowledge("ranges", 1));

    assert.equal(chunks[0].section, undefined);
    assert.deepEqual(warnings, [], "a service that sends no section is not warning-worthy");
  });

  it("parses a hit from a service that predates the routing metadata", async () => {
    // The degraded deployment of 7.3: an older /search sends neither the
    // address, the collections nor the position, and every turn that follows
    // must generate rather than fail. Parsing is where that has to survive, so
    // the absent fields are asserted as absent rather than defaulted here — a
    // caller distinguishes "no collections reported" from "this source is in
    // none", and only the service can say which it meant.
    stubFetch(200, {
      results: [{ text: "An older service's chunk.", score: 0.6, source_name: "guide.pdf" }],
    });

    const chunks = expectOk(await searchKnowledge("star method", 1));

    assert.equal(chunks[0].text, "An older service's chunk.");
    assert.equal(chunks[0].source, "guide.pdf");
    assert.equal(chunks[0].score, 0.6, "the score the type already declared is still read");
    assert.equal(chunks[0].address, undefined);
    assert.equal(chunks[0].collections, undefined);
    assert.equal(chunks[0].position, undefined);
    assert.equal(chunks[0].section, undefined);
  });

  it("keeps a source that is in no collection apart from a service that reported none", async () => {
    stubFetch(200, {
      results: [
        {
          text: "An untagged source's chunk.",
          score: 0.6,
          source_name: "notes.txt",
          address: "notes.txt",
          collections: [],
          position: 0,
        },
      ],
    });

    const chunks = expectOk(await searchKnowledge("notes", 1));

    assert.deepEqual(
      chunks[0].collections,
      [],
      "a source in no collection and a service that said nothing about collections are different facts"
    );
    assert.equal(chunks[0].position, 0, "position zero is a position, not a missing one");
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

  /* ── the knowledge section's directive ───────────────────────────── */

  const DIRECTIVE_CHUNKS = [
    {
      text: "The STAR method structures answers as Situation, Task, Action, Result.",
      source: "interview-guide.pdf",
    },
    {
      text: "Behavioral questions probe past experience rather than hypotheticals.",
      source: "behavioral-questions.pdf",
    },
  ];

  /**
   * The section's prose with the numbered chunk lines dropped — what is left is
   * the directive rather than the material it accompanies.
   */
  function directiveOf(system: string): string {
    const section = system.slice(
      system.indexOf("Relevant knowledge:"),
      system.indexOf("Rules:")
    );
    return section
      .split("\n")
      .filter((line) => !/^\d+\.\s/.test(line))
      .join("\n");
  }

  it("directs the model to base its reply on the chunks", () => {
    const system = buildVoiceAgentPrompt(
      "You are an interview coach.",
      "english",
      [],
      DIRECTIVE_CHUNKS
    )[0].content;
    const directive = directiveOf(system);

    assert.ok(system.includes("Relevant knowledge:"), "the section keeps its label");
    assert.ok(
      /relevan/i.test(directive) && /material|chunks/i.test(directive),
      `the directive must scope itself to material relevant to the turn; got ${directive}`
    );
    assert.ok(
      /prefer/i.test(directive),
      `the directive must prefer the material's terminology and specifics; got ${directive}`
    );
    assert.ok(
      /contradict/i.test(directive),
      `the directive must forbid contradicting the material — this is what makes it authoritative; got ${directive}`
    );
    assert.ok(
      /not cover|doesn't cover|does not cover/i.test(directive),
      `the directive must leave the persona free to reply when the material misses the turn; got ${directive}`
    );
  });

  it("adds nothing at all when there are no chunks", () => {
    // Pinned literally, so an edit that moves the directive somewhere
    // unconditional — the Rules block, say — fails here rather than silently
    // changing every no-knowledge turn.
    const expected = `You are an interview coach.

Rules:
- Conduct the entire conversation in english. Replies must be in english only.
- Keep replies concise and conversational.
- Use Markdown only when it helps clarity.`;

    const omitted = buildVoiceAgentPrompt(
      "You are an interview coach.",
      "english",
      [],
      undefined
    );
    const empty = buildVoiceAgentPrompt("You are an interview coach.", "english", [], []);

    assert.equal(
      omitted[0].content,
      expected,
      "a turn with no chunks must build exactly the prompt it builds with no retrieval at all"
    );
    assert.deepEqual(
      empty,
      omitted,
      "a successful empty result and no search at all are the same prompt"
    );
  });

  it("carries no citation instruction, because the reply is spoken", () => {
    const system = buildVoiceAgentPrompt(
      "You are an interview coach.",
      "english",
      [],
      DIRECTIVE_CHUNKS
    )[0].content;
    const directive = directiveOf(system);

    assert.ok(
      !directive.includes("["),
      `a bracketed source name survives stripMarkdown and is read aloud; got ${directive}`
    );
    assert.ok(
      !/cite|citation/i.test(directive),
      `the directive must not ask for citations; got ${directive}`
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

  it("sends the expansion only when the caller asks for a section", async () => {
    // The material locator's request: scoped, one result, and a section. The
    // generating path's search — the case above — sends no such field, which is
    // what keeps its request byte-identical to the one it has always sent.
    const sent = captureRequestBody();

    await searchKnowledge("súng săn", 1, ["truyen-cuoi"], { expand: "section" });

    assert.deepEqual(sent[0], {
      query: "súng săn",
      top_k: 1,
      collections: ["truyen-cuoi"],
      expand: "section",
    });
  });

  it("omits the expansion when the options carry none", async () => {
    const sent = captureRequestBody();

    await searchKnowledge("star method", 3, ["truyen-kiem-hiep"], {});

    assert.ok(
      !("expand" in sent[0]),
      `an unasked-for expansion would change the generating path's request; got ${JSON.stringify(sent[0])}`
    );
  });
});

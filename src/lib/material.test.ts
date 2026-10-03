import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  resolveMaterialReply,
  selectMaterialHit,
  type MaterialFallbackReason,
  type MaterialOutcome,
  type MaterialPolicy,
} from "./material";
import type { KnowledgeChunk, KnowledgeSearchOutcome } from "./knowledge";

/**
 * These tests never touch a live doc-etl-api and never read a database. The
 * gate is pure and the reply is read off the search's own payload, so both
 * halves are pinned offline — which is the whole reason the decision lives in
 * `src/lib/` rather than inline in the route (design.md D9).
 */

/** The development policy: the two wiki collections and the measured floor. */
const POLICY: MaterialPolicy = { collections: ["truyen-kiem-hiep", "kiem-hiep"], scoreFloor: 0.55 };

/** A located hit, in the shape doc-etl-api reports one. */
function hit(overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    // Deliberately unlike the section's own text, so a test can tell a reply that
    // spoke the passage from one that quoted the ranked chunk (D1).
    text: "the text the search quoted",
    source: "Trang Quynh",
    score: 0.71,
    address: "https://example.org/wiki/Tr%E1%BA%A1ng_Qu%E1%BB%B3nh",
    collections: ["truyen-kiem-hiep"],
    position: 3,
    // A located hit carries the passage that answers it: the document's own text
    // over the run of chunks it belongs to, the range that text was sliced from,
    // and the length the whole section holds. The span and the stated length agree,
    // which is what the gate reads as a whole section.
    section: { text: "the stored passage the hit located.", start: 1200, end: 1235, size: 35 },
    ...overrides,
  };
}

/** A search outcome that located `chunks`. */
function located(...chunks: KnowledgeChunk[]): KnowledgeSearchOutcome {
  return { ok: true, chunks };
}

/** Silence warnings and hand back what was warned. */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.join(" "));
  });
  return warnings;
}

/** Fail loudly rather than reading `.text` off a fallback outcome. */
function expectReply(outcome: MaterialOutcome): string {
  assert.ok(outcome.ok, `expected a reply, got ${JSON.stringify(outcome)}`);
  return outcome.text;
}

/** Fail loudly rather than reading `.reason` off a reply. */
function expectReason(outcome: MaterialOutcome): MaterialFallbackReason {
  assert.ok(!outcome.ok, `expected a fallback, got ${JSON.stringify(outcome)}`);
  return outcome.reason;
}

describe("selectMaterialHit — the gate", () => {
  it("locates a hit the persona asked for, in a speakable collection, at or above the floor", () => {
    const selection = selectMaterialHit({
      outcome: located(hit()),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(selection.ok, `expected a hit, got ${JSON.stringify(selection)}`);
    assert.equal(selection.hit.address, hit().address);
  });

  it("generates for a persona that did not ask for material replies", () => {
    const selection = selectMaterialHit({
      outcome: located(hit()),
      answerMode: "generate",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "generate_mode");
  });

  it("generates when the search located nothing", () => {
    const selection = selectMaterialHit({
      outcome: located(),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "no_hit");
  });

  it("generates when the search failed", () => {
    const selection = selectMaterialHit({
      outcome: { ok: false, reason: "timeout" },
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "no_hit");
  });

  it("generates when no search was issued at all", () => {
    // A material turn whose enabled topics fold to no collection never searches,
    // so it arrives here with nothing to gate on rather than with a refusal.
    const selection = selectMaterialHit({
      outcome: null,
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "no_hit");
  });

  it("generates when the hit's source is in no speakable collection", () => {
    const selection = selectMaterialHit({
      outcome: located(hit({ collections: ["truyen-cuoi"] })),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "not_speakable");
  });

  it("generates for a hit whose source reported no collections at all", () => {
    // The degraded deployment (D6): a doc-etl-api older than the routing fields
    // cannot say which collection a hit is in, so this side cannot say it is
    // speakable, and every turn generates exactly as it does today.
    const selection = selectMaterialHit({
      outcome: located(hit({ collections: undefined })),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "not_speakable");
  });

  it("generates for a hit in a collection the corpus serves but this deployment does not speak", () => {
    // `collections: []` is a source in no collection; here the source is in a
    // real one and the deployment still refuses it, which is the difference
    // between the corpus's shape and the operator's choice.
    const selection = selectMaterialHit({
      outcome: located(hit({ collections: ["truyen-cuoi"] })),
      answerMode: "material",
      policy: { collections: [], scoreFloor: 0.55 },
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "not_speakable");
  });

  it("generates every turn when the deployment speaks no collection", () => {
    // Production's default, asserted as the property that makes shipping this
    // safe (D5): with nothing speakable, a high-scoring hit in a real collection
    // changes nothing about the turn.
    const selection = selectMaterialHit({
      outcome: located(hit({ score: 0.99 })),
      answerMode: "material",
      policy: { collections: [], scoreFloor: 0.55 },
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "not_speakable");
  });

  it("generates when the hit is below the floor", () => {
    const selection = selectMaterialHit({
      outcome: located(hit({ score: 0.54 })),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "below_floor");
  });

  it("generates when the hit reported no score", () => {
    // An unreported score is not a confident one — there is no number that says
    // so — so it cannot pass a floor.
    const selection = selectMaterialHit({
      outcome: located(hit({ score: undefined })),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "below_floor");
  });

  it("generates when the hit carries no section", () => {
    // The older service, a source holding no range to place the run by, and the
    // unasked-for search alike: none can say what this hit's passage is, so the
    // search's quote is not spoken as the whole of it.
    const selection = selectMaterialHit({
      outcome: located(hit({ section: undefined })),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "no_section");
  });

  it("locates a whole section that holds no words, leaving that refusal to the reply", () => {
    // The `0 === 0` case is no longer the gate's to refuse: the span and the stated
    // length are the service's own numbers and they agree, so the section is whole.
    // A present section holding no words is a different fact from a hit the service
    // sent no section for, and it is the reply that refuses it — as `text_empty`.
    const selection = selectMaterialHit({
      outcome: located(hit({ section: { text: "", start: 10, end: 10, size: 0 } })),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(selection.ok, `expected a hit, got ${JSON.stringify(selection)}`);
  });

  it("generates when the section did not come back whole", () => {
    // A bounded expansion: the window the cap allowed, against the length the whole
    // section holds. An incomplete joke is worse than a generated one, so the
    // fragment is refused rather than spoken as though it were the passage.
    const selection = selectMaterialHit({
      outcome: located(
        hit({
          section: {
            text: "## Chiêu thức\nChiêu thứ nhất...",
            start: 900,
            end: 931,
            size: 4200,
          },
        })
      ),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "section_incomplete");
  });

  it("generates when the section's span does not agree with its stated length either way", () => {
    // An unstated length is refused earlier, by the parse, as no section: without
    // one the passage cannot be known to be whole. What is left for the gate is the
    // comparison itself, and it is an equality — a span wider than the length
    // stated is not a whole section either, so it is refused rather than trusted
    // for being the surprising direction.
    const selection = selectMaterialHit({
      outcome: located(
        hit({ section: { text: "Một câu chuyện.", start: 1200, end: 1260, size: 30 } })
      ),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "section_incomplete");
  });

  it("locates a hit sitting exactly on the floor", () => {
    const selection = selectMaterialHit({
      outcome: located(hit({ score: 0.55 })),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(selection.ok, `expected a hit, got ${JSON.stringify(selection)}`);
  });

  it("prefers the preference to the gates, so an ineligible persona is refused before its hit is read", () => {
    const selection = selectMaterialHit({
      outcome: located(hit({ score: 0.99 })),
      answerMode: "generate",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "generate_mode");
  });

  it("reads the first eligible hit when the ranking puts an unspeakable one first", () => {
    // A reused prefetch was issued for the generating path and may hold three
    // chunks, so this is reachable with the locator asking for one. A persona
    // whose topics span a speakable collection and an unspeakable one should be
    // answered from the speakable one rather than from whichever the ranking
    // happened to put first.
    const speakable = hit({ score: 0.60, position: 9 });
    const selection = selectMaterialHit({
      outcome: located(
        hit({ collections: ["truyen-cuoi"], score: 0.90, position: 1 }),
        speakable
      ),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(selection.ok, `expected a hit, got ${JSON.stringify(selection)}`);
    assert.equal(selection.hit.position, 9);
  });

  it("reports the top-ranked hit's reason when no candidate is eligible", () => {
    const selection = selectMaterialHit({
      outcome: located(
        hit({ collections: ["truyen-cuoi"], score: 0.90 }),
        hit({ collections: ["kiem-hiep"], score: 0.20 })
      ),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(!selection.ok);
    assert.equal(selection.reason, "not_speakable");
  });
});

describe("resolveMaterialReply — the reply", () => {
  afterEach(() => mock.restoreAll());

  /** A hit whose section is this text, as the service sliced it from the document. */
  function sectioned(text: string): KnowledgeChunk {
    // The heading appears once because the passage is the source's own characters
    // over the run of chunks, not those chunks joined: every stored chunk repeats
    // the heading, and the service's slice is what makes it read once (D4). The
    // span and the stated length are the text's own width, which is what the gate
    // reads as a whole section.
    return hit({ section: { text, start: 1200, end: 1200 + text.length, size: text.length } });
  }

  it("speaks the hit's section, with the heading spoken once", async () => {
    // The unit the archived design got wrong: one chunk of this joke is a third of
    // it, and every stored chunk carries the heading prefixed. The passage is the
    // document's own run of characters, so the heading opens it exactly once and
    // there is no boundary between chunks to join and no repeated heading to strip.
    const section =
      "## SÚNG SĂN\nMột người thợ săn nọ...\n\n...bèn bắn vào bụi rậm.\n\nNgười đi đường cười ồ.";
    const outcome = await resolveMaterialReply({
      outcome: located(sectioned(section)),
      answerMode: "material",
      policy: POLICY,
    });

    const reply = expectReply(outcome);
    assert.equal(reply, section);
    assert.equal(
      reply.split("## SÚNG SĂN").length - 1,
      1,
      "the heading should be spoken once, not once per chunk"
    );
  });

  it("speaks a one-chunk section as it stands", async () => {
    const outcome = await resolveMaterialReply({
      outcome: located(sectioned("Một câu chuyện ngắn.")),
      answerMode: "material",
      policy: POLICY,
    });

    assert.equal(expectReply(outcome), "Một câu chuyện ngắn.");
  });

  it("speaks the section untrimmed, so what is heard is what the index holds", async () => {
    const outcome = await resolveMaterialReply({
      outcome: located(sectioned("  Một người thợ săn nọ...  ")),
      answerMode: "material",
      policy: POLICY,
    });

    assert.equal(expectReply(outcome), "  Một người thợ săn nọ...  ");
  });

  it("generates rather than speaking a fragment of the passage", async () => {
    // The spec's refusal: a bounded expansion's fragment is not spoken as though
    // it were the whole joke — the service's own two numbers say it is not.
    const outcome = await resolveMaterialReply({
      outcome: located(
        hit({
          section: {
            text: "## Chiêu thức\nChiêu thứ nhất...",
            start: 900,
            end: 931,
            size: 4200,
          },
        })
      ),
      answerMode: "material",
      policy: POLICY,
    });

    assert.equal(expectReason(outcome), "section_incomplete");
  });

  it("generates when the section holds no text", async () => {
    captureWarnings();

    const outcome = await resolveMaterialReply({
      outcome: located(sectioned("")),
      answerMode: "material",
      policy: POLICY,
    });

    assert.equal(expectReason(outcome), "text_empty");
  });

  it("generates when the section holds only whitespace", async () => {
    captureWarnings();

    const outcome = await resolveMaterialReply({
      outcome: located(sectioned("   \n  ")),
      answerMode: "material",
      policy: POLICY,
    });

    assert.equal(expectReason(outcome), "text_empty");
  });

  it("carries the hit it spoke from, so the caller can log which source answered", async () => {
    const outcome = await resolveMaterialReply({
      outcome: located(sectioned("Một câu chuyện ngắn.")),
      answerMode: "material",
      policy: POLICY,
    });

    assert.ok(outcome.ok);
    assert.equal(outcome.hit.source, "Trang Quynh");
    assert.equal(outcome.hit.score, 0.71);
  });

  it("returns the gate's reason for a persona that did not ask for material", async () => {
    const outcome = await resolveMaterialReply({
      outcome: located(sectioned("Một câu chuyện ngắn.")),
      answerMode: "generate",
      policy: POLICY,
    });

    assert.equal(expectReason(outcome), "generate_mode");
  });

  it("returns the gate's reason rather than a reply when the search located nothing", async () => {
    const outcome = await resolveMaterialReply({
      outcome: { ok: true, chunks: [] },
      answerMode: "material",
      policy: POLICY,
    });

    assert.equal(expectReason(outcome), "no_hit");
  });
});

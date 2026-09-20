import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COLLECTION_NAME_PATTERN,
  MAX_COLLECTION_NAME_LENGTH,
  findUnservedTopics,
  foldTopicLabel,
  resolveCollections,
} from "./topics";

/**
 * The nine distinct topic labels across all personas, copied from the client's
 * `src/app/[locale]/voice-agent/personas.ts` on 2026-09-20 ("Behavioral
 * Questions" appears on two personas, hence nine and not ten). Pinned here as a
 * fixture because the two repositories do not share a module — and a pinned
 * expectation is the point: if a label is edited in the persona, the fold's
 * result for it is what this file records, and 2.6's catalog assertion is what
 * catches a label the corpus does not serve.
 */
const PERSONA_TOPIC_LABELS = [
  "Story teller",
  "Behavioral Questions",
  "STAR Method",
  "Technical Interview",
  "C# 12",
  "System Design",
  "Algorithms",
  "Truyện kiếm hiệp",
  "Chăm sóc người lớn tuổi",
] as const;

describe("foldTopicLabel", () => {
  it("folds every persona topic label to a name doc-etl-api accepts", () => {
    for (const label of PERSONA_TOPIC_LABELS) {
      const name = foldTopicLabel(label);
      assert.match(
        name,
        COLLECTION_NAME_PATTERN,
        `"${label}" folded to "${name}", outside COLLECTION_NAME_PATTERN`
      );
      assert.ok(
        name.length <= MAX_COLLECTION_NAME_LENGTH,
        `"${label}" folded to ${name.length} characters, over the ${MAX_COLLECTION_NAME_LENGTH} limit`
      );
    }
  });

  it("does not collide two labels onto one collection name", () => {
    const names = PERSONA_TOPIC_LABELS.map(foldTopicLabel);
    assert.equal(
      new Set(names).size,
      PERSONA_TOPIC_LABELS.length,
      `two labels folded to the same name: ${JSON.stringify(names.sort())}`
    );
  });

  it("folds the label the corpus is tagged with onto its collection", () => {
    assert.equal(foldTopicLabel("Truyện kiếm hiệp"), "truyen-kiem-hiep");
    assert.equal(foldTopicLabel("Chăm sóc người lớn tuổi"), "cham-soc-nguoi-lon-tuoi");
  });

  it("folds a non-alphanumeric run to a single hyphen", () => {
    assert.equal(foldTopicLabel("C# 12"), "c-12");
    assert.equal(foldTopicLabel("  STAR   Method  "), "star-method");
  });

  it("folds đ as a letter rather than letting it become a hyphen", () => {
    assert.equal(foldTopicLabel("Đường phố"), "duong-pho");
  });

  it("folds a label with nothing alphanumeric in it to the empty name", () => {
    assert.equal(foldTopicLabel("!!!"), "");
    assert.equal(foldTopicLabel(""), "");
  });
});

describe("resolveCollections", () => {
  it("resolves nothing when no label survives, so no unscoped search is issued", () => {
    const { collections, dropped } = resolveCollections(["!!!", "???"]);

    assert.deepEqual(collections, []);
    assert.deepEqual(dropped, ["!!!", "???"]);
  });

  it("keeps only the names that survived and names the labels it dropped", () => {
    const { collections, dropped } = resolveCollections([
      "Truyện kiếm hiệp",
      "!!!",
      "STAR Method",
    ]);

    assert.deepEqual(collections, ["truyen-kiem-hiep", "star-method"]);
    assert.deepEqual(dropped, ["!!!"]);
  });

  it("collapses duplicates so one scope has one spelling", () => {
    const { collections } = resolveCollections([
      "Truyện kiếm hiệp",
      "Truyện Kiếm Hiệp",
      "truyện  kiếm   hiệp",
    ]);

    assert.deepEqual(collections, ["truyen-kiem-hiep"]);
  });
});

describe("findUnservedTopics", () => {
  it("reports nothing when a catalog serves every label", () => {
    const catalog = [
      "story-teller",
      "behavioral-questions",
      "star-method",
      "technical-interview",
      "c-12",
      "system-design",
      "algorithms",
      "truyen-kiem-hiep",
      "cham-soc-nguoi-lon-tuoi",
    ];

    assert.deepEqual(findUnservedTopics([...PERSONA_TOPIC_LABELS], catalog), []);
  });

  it("reports a label whose folded spelling the catalog disagrees with", () => {
    // The case D8 keeps an override table for: the fold says `c-12`, an operator
    // hand-tagged the source `csharp-12`. Neither name is wrong; the silence is.
    const catalog = ["csharp-12", "truyen-kiem-hiep"];

    assert.deepEqual(findUnservedTopics(["C# 12", "Truyện kiếm hiệp"], catalog), [
      { label: "C# 12", collection: "c-12" },
    ]);
  });

  it("reports an unserved persona rather than leaving it silently empty", () => {
    assert.deepEqual(findUnservedTopics(["STAR Method"], ["truyen-kiem-hiep"]), [
      { label: "STAR Method", collection: "star-method" },
    ]);
  });

  it("skips a label folding to no name, which is 2.3's rule and no claim about the catalog", () => {
    assert.deepEqual(findUnservedTopics(["!!!", "Algorithms"], ["algorithms"]), []);
  });

  /**
   * A record of the corpus as it stood when this was written, not an endorsement
   * of it: `GET /sources` reported ten sources, every one tagged exactly
   * `["truyen-kiem-hiep","kiem-hiep"]` (1.2's note, 2026-09-20). So the corpus
   * serves one persona's topic and eight labels resolve to collections nothing
   * belongs to — which is why 2.5's empty-result path is the ordinary path for
   * eight of the nine, and why scoping changes no result set today.
   *
   * This test is expected to fail the moment the corpus grows, which is the
   * moment to re-read 1.2's note rather than to relax this assertion.
   */
  it("reports the eight labels today's corpus does not serve", () => {
    const liveCatalogAsMeasured = ["truyen-kiem-hiep", "kiem-hiep"];
    const unserved = findUnservedTopics([...PERSONA_TOPIC_LABELS], liveCatalogAsMeasured);

    assert.equal(unserved.length, 8, `expected 8 unserved, got ${JSON.stringify(unserved)}`);
    assert.deepEqual(
      unserved.map((u) => u.label),
      [
        "Story teller",
        "Behavioral Questions",
        "STAR Method",
        "Technical Interview",
        "C# 12",
        "System Design",
        "Algorithms",
        "Chăm sóc người lớn tuổi",
      ]
    );
  });
});

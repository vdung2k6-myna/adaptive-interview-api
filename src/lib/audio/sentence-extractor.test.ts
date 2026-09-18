import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SentenceExtractor } from "./sentence-extractor";
import { hasUnclosedCodeFence } from "./text-processing";

describe("SentenceExtractor", () => {
  it("emits nothing until a delimiter arrives", () => {
    const ex = new SentenceExtractor();
    assert.deepEqual(ex.feed("Hello"), []);
    assert.deepEqual(ex.feed(" world."), [
      { raw: "Hello world.", clean: "Hello world.", chunks: ["Hello world."] },
    ]);
  });

  it("accumulates across multiple tokens", () => {
    const ex = new SentenceExtractor();
    assert.deepEqual(ex.feed("One "), []);
    assert.deepEqual(ex.feed("two "), []);
    assert.deepEqual(ex.feed("three. Four "), [
      { raw: "One two three.", clean: "One two three.", chunks: ["One two three."] },
    ]);
  });

  it("emits multiple sentences from one token", () => {
    const ex = new SentenceExtractor();
    const results = ex.feed("First. Second. Third.");
    assert.equal(results.length, 3);
    assert.equal(results[0].clean, "First.");
    assert.equal(results[1].clean, "Second.");
    assert.equal(results[2].clean, "Third.");
  });

  it("skips sentences with no letters", () => {
    const ex = new SentenceExtractor();
    assert.deepEqual(ex.feed("42. "), []);
    assert.deepEqual(ex.feed("Real text."), [
      { raw: "Real text.", clean: "Real text.", chunks: ["Real text."] },
    ]);
  });

  it("strips inline ordered-list markers from sentences", () => {
    const ex = new SentenceExtractor();
    // Simulate LLM outputting list items on one line.
    const results = ex.feed("1. Foo. 2. Bar. 3. Baz.");
    // "1." and "2." are removed by stripMarkdown at line start, but "3."
    // would remain inline if the text were all on one line.  Our per-sentence
    // cleanup strips any leading "N. " so TTS doesn't speak the number.
    const cleans = results.map((r) => r.clean);
    assert.deepEqual(cleans, ["Foo.", "Bar.", "Baz."]);
  });

  it("strips bullet markers from sentence starts", () => {
    const ex = new SentenceExtractor();
    const results = ex.feed("• First. - Second. * Third.");
    const cleans = results.map((r) => r.clean);
    assert.deepEqual(cleans, ["First.", "Second.", "Third."]);
  });

  it("respects shouldSkip predicate", () => {
    const ex = new SentenceExtractor({
      shouldSkip: hasUnclosedCodeFence,
    });
    assert.deepEqual(ex.feed("Here is some ```python\n"), []);
    const results = ex.feed("code\n```. That is all.");
    assert.equal(results.length, 2);
    assert.ok(results[0].clean.includes("Here is some code"));
    assert.equal(results[1].clean, "That is all.");
  });

  it("finalize returns trailing sentences after stream ends", () => {
    const ex = new SentenceExtractor();
    ex.feed("Hello. World");
    const tail = ex.finalize();
    assert.equal(tail.length, 1);
    assert.equal(tail[0].clean, "World");
  });

  it("finalize returns empty when all sentences were emitted", () => {
    const ex = new SentenceExtractor();
    ex.feed("Hello. World.");
    assert.deepEqual(ex.finalize(), []);
  });

  it("finalize salvages text after last delimiter", () => {
    const ex = new SentenceExtractor();
    ex.feed("Hello. What is your");
    const tail = ex.finalize();
    assert.equal(tail.length, 1);
    assert.equal(tail[0].clean, "What is your");
  });

  it("finalize uses fullText when provided", () => {
    const ex = new SentenceExtractor();
    ex.feed("Hel"); // partial
    const tail = ex.finalize("Hello world.");
    assert.equal(tail.length, 1);
    assert.equal(tail[0].clean, "Hello world.");
  });

  it("finalize avoids duplicate tail already captured as sentence", () => {
    const ex = new SentenceExtractor();
    ex.feed("Hello. World");
    const tail = ex.finalize("Hello. World");
    assert.equal(tail.length, 1);
    assert.equal(tail[0].clean, "World");
  });

  it("finalize does not return tail without letters", () => {
    const ex = new SentenceExtractor();
    ex.feed("Hello. 42");
    const tail = ex.finalize();
    assert.equal(tail.length, 0);
  });

  it("handles Vietnamese delimiters", () => {
    const ex = new SentenceExtractor();
    const results = ex.feed("Xin chào. Bạn khỏe không？");
    assert.equal(results.length, 2);
    assert.equal(results[0].clean, "Xin chào.");
    assert.equal(results[1].clean, "Bạn khỏe không？");
  });

  it("chunks long sentences via splitForTTS", () => {
    const ex = new SentenceExtractor();
    const longSentence =
      "Trong dự án vừa rồi, bạn đã sử dụng những công cụ nào để quản lý cơ sở dữ liệu và đảm bảo hiệu năng?";
    const results = ex.feed(longSentence);
    assert.equal(results.length, 1);
    assert.ok(results[0].chunks.length >= 2, "expected sentence to be chunked");
  });

  it("feed + finalize with code fence open/close end-to-end", () => {
    const ex = new SentenceExtractor({
      shouldSkip: hasUnclosedCodeFence,
    });
    ex.feed("Explain this: ```python\ndef hello():\n");
    const results = ex.feed("    pass\n```. That is all.");
    // The code fence content should have been stripped by stripMarkdown
    // and emitted after the fence closed.
    const cleans = results.map((r) => r.clean);
    assert.ok(
      cleans.some((c) => c.includes("That is all")),
      `expected "That is all" in results: ${JSON.stringify(cleans)}`
    );
  });

  it("getAccumulated returns raw accumulated text", () => {
    const ex = new SentenceExtractor();
    ex.feed("Hello");
    assert.equal(ex.getAccumulated(), "Hello");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitSentences } from "./split-sentences";

describe("splitSentences", () => {
  it("keeps a decimal numeral inside one sentence", () => {
    assert.deepEqual(
      splitSentences("Ở đó tôi đã có 3.5 năm kinh nghiệm với vai trò kỹ sư phần mềm."),
      ["Ở đó tôi đã có 3.5 năm kinh nghiệm với vai trò kỹ sư phần mềm."]
    );
  });

  it("keeps a trailing decimal numeral with its sentence", () => {
    // A guard that swallowed every period after a digit would leave this as
    // one sentence either way, so the numeral must not be split into "3." + "5.".
    assert.deepEqual(splitSentences("Chỉ số đó là 3.5."), ["Chỉ số đó là 3.5."]);
  });

  it("keeps a version-style number whole", () => {
    assert.deepEqual(
      splitSentences("Bạn đã từng làm việc với PostgreSQL phiên bản 15.4 trong dự án lớn chưa?"),
      ["Bạn đã từng làm việc với PostgreSQL phiên bản 15.4 trong dự án lớn chưa?"]
    );
  });

  it("still ends a sentence on a numeral", () => {
    // Meaningful only because a sentence follows: were the guard too broad,
    // this would come back as a single sentence.
    assert.deepEqual(splitSentences("Tổng cộng là 42. Sau đó chúng ta tiếp tục."), [
      "Tổng cộng là 42.",
      "Sau đó chúng ta tiếp tục.",
    ]);
  });

  it("splits after a decimal numeral when the next sentence begins", () => {
    assert.deepEqual(
      splitSentences("Tôi có 3.5 năm kinh nghiệm. Sau đó tôi chuyển sang công ty khác."),
      ["Tôi có 3.5 năm kinh nghiệm.", "Sau đó tôi chuyển sang công ty khác."]
    );
  });

  it("splits a multi-sentence reply and keeps an unterminated tail", () => {
    assert.deepEqual(splitSentences("Chào bạn. Rất vui được gặp bạn. Trước tiên"), [
      "Chào bạn.",
      "Rất vui được gặp bạn.",
      "Trước tiên",
    ]);
  });

  it("preserves runs of delimiters", () => {
    assert.deepEqual(splitSentences("Thật sao?! Đúng vậy..."), ["Thật sao?!", "Đúng vậy..."]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    assert.deepEqual(splitSentences(""), []);
    assert.deepEqual(splitSentences("   \n "), []);
  });
});

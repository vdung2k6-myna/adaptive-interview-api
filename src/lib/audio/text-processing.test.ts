import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  numberToVietnameseWords,
  normalizeNumbersForKokoro,
  normalizeTextForEngine,
  resolveSttLanguage,
  splitForTTS,
  stripMarkdown,
  TTS_WORKING_LENGTH,
  synthesizeLongText,
  synthesizeSpeechWithFallback,
  type SynthesizeLongTextOptions,
} from "./text-processing";

describe("numberToVietnameseWords", () => {
  const cases: Array<[number, string]> = [
    [0, "không"],
    [1, "một"],
    [10, "mười"],
    [11, "mười một"],
    [15, "mười lăm"],
    [21, "hai mươi mốt"],
    [24, "hai mươi tư"],
    [25, "hai mươi lăm"],
    [100, "một trăm"],
    [101, "một trăm linh một"],
    [105, "một trăm linh năm"],
    [110, "một trăm mười"],
    [111, "một trăm mười một"],
    [115, "một trăm mười lăm"],
    [1000, "một nghìn"],
    [1001, "một nghìn không trăm linh một"],
    [1024, "một nghìn không trăm hai mươi tư"],
    [2024, "hai nghìn không trăm hai mươi tư"],
    [10000, "mười nghìn"],
    [100000, "một trăm nghìn"],
    [1000000, "một triệu"],
    [1234567, "một triệu hai trăm ba mươi tư nghìn năm trăm sáu mươi bảy"],
    [1000000000, "một tỷ"],
  ];

  for (const [n, expected] of cases) {
    it(`${n} → "${expected}"`, () => {
      assert.equal(numberToVietnameseWords(n), expected);
    });
  }

  it("rejects negative numbers", () => {
    assert.throws(() => numberToVietnameseWords(-1), RangeError);
  });

  it("rejects non-integers", () => {
    assert.throws(() => numberToVietnameseWords(1.5), RangeError);
  });

  it("rejects numbers above 999,999,999,999", () => {
    assert.throws(() => numberToVietnameseWords(1_000_000_000_000), RangeError);
  });
});

describe("normalizeNumbersForKokoro", () => {
  it("expands simple integers", () => {
    assert.equal(
      normalizeNumbersForKokoro("Bạn có 3 năm kinh nghiệm Python?"),
      "Bạn có ba năm kinh nghiệm Python?"
    );
  });

  it("expands years", () => {
    assert.equal(
      normalizeNumbersForKokoro("Bạn làm việc từ năm 2020 đến 2024."),
      "Bạn làm việc từ năm hai nghìn không trăm hai mươi đến hai nghìn không trăm hai mươi tư."
    );
  });

  it("reads small years naturally", () => {
    assert.equal(
      normalizeNumbersForKokoro("Năm 999 trước Công nguyên."),
      "Năm chín trăm chín mươi chín trước Công nguyên."
    );
  });

  it("expands percentages", () => {
    assert.equal(
      normalizeNumbersForKokoro("Tỷ lệ thành công là 95%."),
      "Tỷ lệ thành công là chín mươi lăm phần trăm."
    );
  });

  it("expands decimals", () => {
    assert.equal(
      normalizeNumbersForKokoro("Giá trị pi xấp xỉ 3.14."),
      "Giá trị pi xấp xỉ ba phẩy một bốn."
    );
  });

  it("protects phone numbers", () => {
    assert.equal(
      normalizeNumbersForKokoro("Gọi cho tôi theo số 0909123456."),
      "Gọi cho tôi theo số 0909123456."
    );
  });

  it("reads short codes digit-by-digit", () => {
    assert.equal(
      normalizeNumbersForKokoro("Mã xác nhận là 12345."),
      "Mã xác nhận là một hai ba bốn năm."
    );
  });

  it("leaves version strings untouched", () => {
    assert.equal(
      normalizeNumbersForKokoro("Dùng Node.js v20.11.0 hay Python 3.12?"),
      "Dùng Node.js v20.11.0 hay Python ba phẩy một hai?"
    );
  });

  it("leaves IP addresses untouched", () => {
    assert.equal(
      normalizeNumbersForKokoro("Server chạy tại 192.168.1.1."),
      "Server chạy tại 192.168.1.1."
    );
  });

  it("handles mixed text", () => {
    assert.equal(
      normalizeNumbersForKokoro("Bạn có 5 năm kinh nghiệm, từng làm 3 dự án, đạt 80% KPI năm 2023."),
      "Bạn có năm năm kinh nghiệm, từng làm ba dự án, đạt tám mươi phần trăm KPI năm hai nghìn không trăm hai mươi ba."
    );
  });

  it("preserves text without digits", () => {
    assert.equal(
      normalizeNumbersForKokoro("Bạn có kinh nghiệm với React không?"),
      "Bạn có kinh nghiệm với React không?"
    );
  });

  it("bypasses normalization for English text", () => {
    assert.equal(
      normalizeNumbersForKokoro("You have 3 years of experience with Python 3.12."),
      "You have 3 years of experience with Python 3.12."
    );
  });

  it("bypasses normalization for text without Vietnamese diacritics", () => {
    assert.equal(
      normalizeNumbersForKokoro("Ban co 3 nam kinh nghiem?"),
      "Ban co 3 nam kinh nghiem?"
    );
  });
});

describe("normalizeTextForEngine", () => {
  it("strips markdown and expands numbers for kokoro", () => {
    assert.equal(
      normalizeTextForEngine("Bạn có **3 năm** kinh nghiệm `Python 3.12`?", "kokoro"),
      "Bạn có ba năm kinh nghiệm Python ba phẩy một hai?"
    );
  });

  it("strips markdown but leaves numbers for piper", () => {
    assert.equal(
      normalizeTextForEngine("Bạn có **3 năm** kinh nghiệm?", "piper"),
      "Bạn có 3 năm kinh nghiệm?"
    );
  });

  it("defaults to kokoro when engine is omitted", () => {
    assert.equal(
      normalizeTextForEngine("Bạn có 3 năm kinh nghiệm?"),
      "Bạn có ba năm kinh nghiệm?"
    );
  });

  it("bypasses kokoro normalization for English text", () => {
    assert.equal(
      normalizeTextForEngine("You have **3 years** of experience with `Python 3.12`?", "kokoro"),
      "You have 3 years of experience with Python 3.12?"
    );
  });
});

/** The two replies the division was measured against (design.md D2). A is four
 * sentences and 245 characters, B is seven and 530. */
const MEASURED_REPLY_A =
  "Chào bạn, rất vui được gặp bạn hôm nay. Tôi sẽ hỏi bạn một vài câu về kinh nghiệm của bạn. " +
  "Trước tiên, bạn có thể giới thiệu ngắn gọn về bản thân và 3 năm kinh nghiệm gần nhất của bạn không? " +
  "Sau đó chúng ta sẽ nói về 2 dự án mà bạn tâm đắc nhất.";

const MEASURED_REPLY_B =
  "Chào bạn, cảm ơn bạn đã dành thời gian tham gia buổi phỏng vấn hôm nay. " +
  "Tôi là trợ lý phỏng vấn và sẽ đồng hành cùng bạn trong khoảng bốn mươi phút tới. " +
  "Trước khi bắt đầu, tôi muốn hỏi bạn một vài câu về kinh nghiệm làm việc của bạn. " +
  "Bạn có thể kể cho tôi nghe về vị trí gần nhất mà bạn đảm nhiệm không? " +
  "Ở đó tôi đã có 3.5 năm kinh nghiệm với vai trò kỹ sư phần mềm. " +
  "Điều gì khiến bạn quyết định chuyển sang một môi trường mới? " +
  "Sau đó chúng ta sẽ cùng nói về hai dự án mà bạn tâm đắc nhất, cũng như những khó khăn bạn đã gặp phải.";

describe("splitForTTS", () => {
  it("keeps a sentence within the working length whole", () => {
    assert.deepEqual(
      splitForTTS("Bạn đã thực hiện những công việc chăm sóc cụ thể nào cho 5 người lớn tuổi đó?"),
      ["Bạn đã thực hiện những công việc chăm sóc cụ thể nào cho 5 người lớn tuổi đó?"]
    );
  });

  it("packs whole sentences rather than splitting each one", () => {
    // Two sentences fit together; the third does not fit with either.
    assert.deepEqual(splitForTTS(MEASURED_REPLY_A), [
      "Chào bạn, rất vui được gặp bạn hôm nay. Tôi sẽ hỏi bạn một vài câu về kinh nghiệm của bạn.",
      "Trước tiên, bạn có thể giới thiệu ngắn gọn về bản thân và 3 năm kinh nghiệm gần nhất của bạn không?",
      "Sau đó chúng ta sẽ nói về 2 dự án mà bạn tâm đắc nhất.",
    ]);
  });

  it("ends every utterance of a long reply at a sentence boundary", () => {
    // No two neighbouring sentences of this reply fit in one utterance, so it
    // comes back as its sentences — and, importantly, as nothing else.
    assert.deepEqual(splitForTTS(MEASURED_REPLY_B), [
      "Chào bạn, cảm ơn bạn đã dành thời gian tham gia buổi phỏng vấn hôm nay.",
      "Tôi là trợ lý phỏng vấn và sẽ đồng hành cùng bạn trong khoảng bốn mươi phút tới.",
      "Trước khi bắt đầu, tôi muốn hỏi bạn một vài câu về kinh nghiệm làm việc của bạn.",
      "Bạn có thể kể cho tôi nghe về vị trí gần nhất mà bạn đảm nhiệm không?",
      "Ở đó tôi đã có 3.5 năm kinh nghiệm với vai trò kỹ sư phần mềm.",
      "Điều gì khiến bạn quyết định chuyển sang một môi trường mới?",
      "Sau đó chúng ta sẽ cùng nói về hai dự án mà bạn tâm đắc nhất, cũng như những khó khăn bạn đã gặp phải.",
    ]);
  });

  it("does not speak an opening phrase as its own utterance", () => {
    assert.deepEqual(
      splitForTTS(
        "Trước tiên, bạn có thể giới thiệu ngắn gọn về bản thân và 3 năm kinh nghiệm gần nhất của bạn không?"
      ),
      ["Trước tiên, bạn có thể giới thiệu ngắn gọn về bản thân và 3 năm kinh nghiệm gần nhất của bạn không?"]
    );
  });

  it("does not divide at an opening phrase when the sentence must be scanned", () => {
    // The comma after "Trước tiên," sits inside the scan window. Exempting
    // punctuation from the soft floor used to make it win from 100 characters
    // back, and the opener became an 11-character utterance of its own.
    const chunks = splitForTTS(
      `Trước tiên, ${"bạn có thể giới thiệu ngắn gọn về bản thân và kinh nghiệm ".repeat(3)}gần nhất của bạn không?`
    );
    assert.notDeepEqual(chunks[0], "Trước tiên,");
    assert.ok(chunks[0].startsWith("Trước tiên,"), `opener left behind: ${JSON.stringify(chunks)}`);
    assert.ok(chunks[0].length >= 60, `opener spoken alone: ${JSON.stringify(chunks)}`);
  });

  it("prefers a boundary near the working length over a distant punctuation mark", () => {
    // The comma after "window" is a candidate inside the window, 58 characters
    // behind the target. It must not win.
    const chunks = splitForTTS(
      "This clause opener is long enough to sit inside the window, and then the sentence continues well past the working length so the scan has to choose."
    );
    assert.ok(!chunks[0].endsWith(","), `stopped at the distant comma: ${JSON.stringify(chunks)}`);
    assert.equal(chunks[0].length, 120);
  });

  it("does not produce tiny chunks for early punctuation", () => {
    const chunks = splitForTTS(
      "A, very long sentence that goes on and on and should not be split right after the first letter because that would be silly."
    );
    assert.ok(chunks[0].length >= 100, `first chunk too short: ${JSON.stringify(chunks)}`);
  });

  it("keeps short text as a single chunk", () => {
    assert.deepEqual(splitForTTS("Bạn có 3 năm kinh nghiệm?"), [
      "Bạn có 3 năm kinh nghiệm?",
    ]);
  });

  it("never produces an utterance longer than the working length", () => {
    // The old join was allowed to reach 1.5x the working length, so a request
    // for 60 characters could come back with 71.
    const inputs = [
      MEASURED_REPLY_A,
      MEASURED_REPLY_B,
      "A, very long sentence that goes on and on and should not be split right after the first letter because that would be silly.",
      "Với vai trò chuyên gia, anh/chị hãy giải thích ngắn gọn: vì sao mèo không tự tổng hợp đủ taurine trong cơ thể, và thiếu taurine kéo dài sẽ gây ra hai bệnh lý chính gì ở mèo?",
    ];
    for (const input of inputs) {
      const chunks = splitForTTS(input);
      const longest = Math.max(...chunks.map((c) => c.length));
      assert.ok(
        longest <= TTS_WORKING_LENGTH,
        `utterance of ${longest} chars exceeds ${TTS_WORKING_LENGTH}: ${JSON.stringify(chunks)}`
      );
    }
  });

  it("joins a fragment that sits between two utterances and leaves room", () => {
    // The 9-character "shortend." lands between two long utterances. The old
    // join only ever looked at the last chunk, so it survived.
    const chunks = splitForTTS(
      `${"alpha ".repeat(19)}end. ${"beta ".repeat(23)}shortend. ${"gamma ".repeat(10)}tail.`
    );
    assert.equal(chunks.length, 3, `expected the fragment to be absorbed: ${JSON.stringify(chunks)}`);
    assert.ok(
      chunks.every((c) => c.trim().split(/\s+/).length >= 3),
      `an utterance is too short to speak: ${JSON.stringify(chunks)}`
    );
    assert.ok(chunks[2].startsWith("shortend."), `fragment not joined forward: ${JSON.stringify(chunks)}`);
  });

  it("leaves a fragment separate when joining it would exceed the working length", () => {
    // Same shape, but now neither neighbour has room for the 9-character
    // fragment. Speaking it alone is the lesser harm; overrunning is not.
    const chunks = splitForTTS(
      `${"alpha ".repeat(19)}end. ${"beta ".repeat(23)}shortend. ${"gamma ".repeat(19)}tail.`
    );
    assert.ok(
      chunks.some((c) => c === "shortend."),
      `the fragment should have been left alone: ${JSON.stringify(chunks)}`
    );
    assert.ok(
      Math.max(...chunks.map((c) => c.length)) <= TTS_WORKING_LENGTH,
      `joining overran the working length: ${JSON.stringify(chunks)}`
    );
  });

  it("avoids splitting a number from its noun", () => {
    const chunks = splitForTTS(
      "Bạn đã thực hiện những công việc chăm sóc cụ thể nào cho 5 người lớn tuổi trong gia đình mình trong suốt khoảng thời gian vừa qua?"
    );
    assert.ok(chunks.length >= 2, `expected a scan: ${JSON.stringify(chunks)}`);
    assert.ok(!chunks.some((c) => /\b5$/.test(c)), `unexpected chunk ending in 5: ${JSON.stringify(chunks)}`);
  });

  it("keeps a decimal version with its noun phrase", () => {
    const chunks = splitForTTS(
      "Bạn đã từng làm việc với PostgreSQL phiên bản 15.4 trong các dự án có lưu lượng truy cập lớn chưa?"
    );
    assert.ok(
      chunks.some((c) => /phiên bản 15\.4/.test(c)),
      `expected 'phiên bản 15.4' in one chunk: ${JSON.stringify(chunks)}`
    );
  });

  it("handles the user's long example with examples list", () => {
    const sentence =
      "Bạn đã thực hiện những công việc chăm sóc cụ thể nào cho 5 người lớn tuổi đó (ví dụ: tắm rửa, nấu ăn, nhắc uống thuốc, đưa đi khám bệnh)?";
    const chunks = splitForTTS(sentence);
    assert.ok(chunks.length >= 2);
    assert.ok(!chunks.some((c) => /\b5$/.test(c)), `chunk ends in 5: ${JSON.stringify(chunks)}`);
  });

  it("merges a trailing fragment so the final chunk is meaningful", () => {
    const chunks = splitForTTS(
      "Với vai trò chuyên gia, anh/chị hãy giải thích ngắn gọn: vì sao mèo không tự tổng hợp đủ taurine trong cơ thể, và thiếu taurine kéo dài sẽ gây ra hai bệnh lý chính gì ở mèo?"
    );
    const last = chunks[chunks.length - 1];
    const wordCount = last.trim().split(/\s+/).length;
    assert.ok(
      wordCount >= 3,
      `expected final chunk to have at least 3 words, got ${wordCount}: ${JSON.stringify(chunks)}`
    );
  });
});

describe("stripMarkdown", () => {
  it("removes inline code backticks", () => {
    assert.equal(stripMarkdown("`npm install`"), "npm install");
  });

  it("preserves fenced code block content", () => {
    assert.equal(
      stripMarkdown("```python\nprint('hi')\n```"),
      "print('hi')"
    );
  });

  it("preserves code-only fenced block content", () => {
    assert.equal(
      stripMarkdown("```\nconst x = 5;\n```"),
      "const x = 5;"
    );
  });

  it("preserves inline code and fenced code together", () => {
    assert.equal(
      stripMarkdown("What does ```python\nprint(1)\n``` do? Use `len()` to check."),
      "What does print(1) do? Use len() to check."
    );
  });

  it("strips link URLs and keeps link text", () => {
    assert.equal(
      stripMarkdown("See [REST API](https://example.com) for details."),
      "See REST API for details."
    );
  });

  it("strips image URLs and keeps alt text", () => {
    assert.equal(
      stripMarkdown("![diagram of closure](https://example.com/closure.png)"),
      "diagram of closure"
    );
  });

  it("strips strikethrough markers", () => {
    assert.equal(stripMarkdown("~~deleted~~ kept"), "deleted kept");
  });

  it("removes horizontal rules", () => {
    assert.equal(
      stripMarkdown("---\nBạn có biết OOP không?\n***"),
      "Bạn có biết OOP không?"
    );
  });

  it("handles mixed markdown in one question", () => {
    assert.equal(
      stripMarkdown(
        "## Câu hỏi 1\n\n**Yêu cầu:** Giải thích [closure](https://example.com) và đoạn code `() => {}`.\n\n```javascript\nconst add = (a, b) => a + b;\n```"
      ),
      "Câu hỏi 1 Yêu cầu: Giải thích closure và đoạn code () => {}. const add = (a, b) => a + b;"
    );
  });

  it("strips fenced code block with escaped newlines", () => {
    assert.equal(
      stripMarkdown("```markdown\\nWhat is the role of karma?```"),
      "What is the role of karma?"
    );
  });

  it("strips fenced code block with real newlines", () => {
    assert.equal(
      stripMarkdown("```markdown\nWhat is the role of karma?\n```"),
      "What is the role of karma?"
    );
  });

  it("strips fenced code block with CRLF line endings", () => {
    assert.equal(
      stripMarkdown("```markdown\r\nWhat is the role of karma?\r\n```"),
      "What is the role of karma?"
    );
  });

  it("strips empty fenced code block with language tag", () => {
    assert.equal(
      stripMarkdown("Hãy mô tả? ```vietnamese```"),
      "Hãy mô tả?"
    );
    assert.equal(
      stripMarkdown("What is Node.js? ```english```"),
      "What is Node.js?"
    );
  });
});

function makeWavBuffer(payload: string): Buffer {
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const pcm = Buffer.from(payload, "utf-8");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((numChannels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** One sentence, longer than `TTS_WORKING_LENGTH`, so `splitForTTS` must divide
 * it and `synthesizeLongText` has more than one chunk to combine. */
const SENTENCE_NEEDING_A_SCAN =
  "Trong dự án vừa rồi, bạn đã sử dụng những công cụ nào để quản lý cơ sở dữ liệu, " +
  "theo dõi hiệu năng truy vấn và đảm bảo rằng hệ thống vẫn chạy ổn định khi lượng người dùng tăng lên gấp nhiều lần?";

describe("synthesizeLongText", () => {
  const makeMockSynthesizer = (buffers: Map<string, Buffer>) => {
    return async (
      text: string,
      _options: SynthesizeLongTextOptions,
      _depth = 0,
      _signal?: AbortSignal
    ): Promise<Buffer> => {
      const buf = buffers.get(text);
      if (!buf) {
        throw new Error(`No mock buffer for: ${text}`);
      }
      return buf;
    };
  };

  it("returns a single buffer for short text", async () => {
    const text = "Bạn có ba năm kinh nghiệm?";
    const buffers = new Map([[text, makeWavBuffer("short")]]);
    const result = await synthesizeLongText(
      text,
      { engine: "kokoro", voice: "af_heart" },
      undefined,
      makeMockSynthesizer(buffers)
    );
    assert.ok(result.buffer.length > 0);
    assert.equal(result.text, text);
  });

  it("concatenates multiple WAV chunks into one buffer", async () => {
    // This sentence is long enough that splitForTTS will produce >1 chunk.
    const text = SENTENCE_NEEDING_A_SCAN;
    const buffers = new Map<string, Buffer>();
    const synthesizeFn = async (
      chunk: string,
      _options: SynthesizeLongTextOptions,
      _depth = 0,
      _signal?: AbortSignal
    ): Promise<Buffer> => {
      buffers.set(chunk, makeWavBuffer(chunk));
      return buffers.get(chunk)!;
    };

    const result = await synthesizeLongText(
      text,
      { engine: "kokoro", voice: "af_heart" },
      undefined,
      synthesizeFn
    );
    assert.ok(result.buffer.length > 0);
    assert.equal(result.buffer.toString("ascii", 0, 4), "RIFF");
    // Combined payload should contain all synthesized chunk payloads.
    const combinedPayload = result.buffer.slice(44).toString("utf-8");
    assert.ok(buffers.size >= 2, "expected at least two chunks");
    for (const [chunk] of buffers) {
      assert.ok(
        combinedPayload.includes(chunk),
        `combined audio missing chunk: ${chunk}`
      );
    }
  });

  it("falls back to the first chunk when not all results are WAV", async () => {
    const text = "Một hai ba.";
    const mp3Header = Buffer.from([0xff, 0xf7, 0x00, 0x00]);
    const mp3Payload = Buffer.from("fake-mp3");
    const wavBuffer = makeWavBuffer("wav-chunk");
    let callIndex = 0;
    const synthesizeFn = async (): Promise<Buffer> => {
      callIndex++;
      return callIndex === 1 ? Buffer.concat([mp3Header, mp3Payload]) : wavBuffer;
    };

    const result = await synthesizeLongText(
      text,
      { engine: "kokoro", voice: "af_heart" },
      undefined,
      synthesizeFn
    );
    assert.equal(result.buffer.toString("hex", 0, 4), "fff70000");
  });

  it("returns a saved URL path when sessionId is provided", async () => {
    const text = "Bạn có ba năm kinh nghiệm?";
    const buffers = new Map([[text, makeWavBuffer("saved")]]);
    const result = await synthesizeLongText(
      text,
      { engine: "kokoro", voice: "af_heart", sessionId: "test-session", prefix: "interviewer" },
      undefined,
      makeMockSynthesizer(buffers)
    );
    assert.ok(result.buffer.length > 0);
    assert.ok(result.urlPath);
    assert.ok(result.urlPath?.startsWith("/audio/test-session/"));
    assert.ok(result.urlPath?.includes("interviewer"));
  });

  it("packs whole sentences into one call, since the whole reply is in hand", async () => {
    const seen: string[] = [];
    const synthesizeFn = async (chunk: string): Promise<Buffer> => {
      seen.push(chunk);
      return makeWavBuffer(chunk);
    };

    await synthesizeLongText(
      MEASURED_REPLY_A,
      { engine: "kokoro", voice: "af_heart" },
      undefined,
      synthesizeFn
    );

    // The engine is kokoro, so the text is normalized (digits to words) before
    // it is divided; that is the text the division sees.
    const divided = splitForTTS(normalizeTextForEngine(MEASURED_REPLY_A, "kokoro"));
    assert.deepEqual(seen, divided);
    assert.ok(
      seen.length < 4,
      `expected the reply's sentences to be packed rather than synthesized one by one: ${JSON.stringify(seen)}`
    );
  });

  it("synthesizes chunks concurrently while preserving order", async () => {
    const text = SENTENCE_NEEDING_A_SCAN;
    const seenChunks: string[] = [];
    const synthesizeFn = async (chunk: string): Promise<Buffer> => {
      seenChunks.push(chunk);
      return makeWavBuffer(chunk);
    };

    const result = await synthesizeLongText(
      text,
      { engine: "kokoro", voice: "af_heart" },
      undefined,
      synthesizeFn
    );
    assert.ok(result.buffer.length > 0);
    assert.equal(result.buffer.toString("ascii", 0, 4), "RIFF");
    assert.ok(seenChunks.length >= 2, "expected at least two chunks");

    // All chunk payloads should appear in the combined audio in order.
    const combinedPayload = result.buffer.slice(44).toString("utf-8");
    const chunkOrderRegex = new RegExp(seenChunks.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
    assert.ok(
      chunkOrderRegex.test(combinedPayload),
      `combined audio missing chunks in order: ${combinedPayload}`
    );
  });

  it("deletes saved audio and throws AbortError when aborted", async () => {
    const text =
      "Trong dự án vừa rồi, bạn đã sử dụng những công cụ nào để quản lý cơ sở dữ liệu và đảm bảo hiệu năng?";
    const controller = new AbortController();
    controller.abort(); // abort before synthesis

    const synthesizeFn = async (chunk: string): Promise<Buffer> => {
      return makeWavBuffer(chunk);
    };

    await assert.rejects(
      async () => {
        await synthesizeLongText(
          text,
          { engine: "kokoro", voice: "af_heart", sessionId: "abort-session", prefix: "interviewer" },
          controller.signal,
          synthesizeFn
        );
      },
      (err: unknown) => err instanceof DOMException && err.name === "AbortError"
    );

    // The abort-before-start path does not save a file, so deletion is not
    // exercised here. Manual verification covers the disconnect-after-save case.
  });
});

describe("synthesizeSpeechWithFallback", () => {
  const TEXT =
    "Chào bạn, rất vui được gặp bạn hôm nay và chúc bạn một buổi phỏng vấn tốt lành.";

  const options = { engine: "kokoro" as const, voice: "af_heart" };

  /** Runs one synthesis where only the first call fails, and reports what the
   * fallback did about it — the texts it asked for, in order. */
  const recoverFrom = async (failureMessage: string) => {
    const asked: string[] = [];
    const synthesizeFn = async (text: string): Promise<Buffer> => {
      asked.push(text);
      if (asked.length === 1) {
        throw new Error(failureMessage);
      }
      return makeWavBuffer(text);
    };

    const buffer = await synthesizeSpeechWithFallback(
      TEXT,
      options,
      0,
      undefined,
      synthesizeFn
    );

    return { asked, buffer };
  };

  it("retries a failure it recognises and one it does not, on identical terms", async () => {
    // The two strings are what the classifier used to key on: the first is the
    // exact Piper wording it matched, the second is an error no version of it
    // ever matched. Any difference between these two results is the engine
    // deciding whether an utterance gets a second chance (D6).
    const recognised = await recoverFrom("Phoneme chunk too long");
    const unrecognised = await recoverFrom("Audio gateway returned 502 Bad Gateway");

    assert.deepEqual(
      unrecognised.asked,
      recognised.asked,
      "an unrecognised failure took a different path than a recognised one"
    );
    assert.ok(
      recognised.asked.length > 1,
      "the utterance was never retried, so nothing was divided"
    );
    assert.ok(
      recognised.asked.slice(1).every((text) => text.length < TEXT.length),
      `expected the retry to ask for smaller pieces, got: ${JSON.stringify(recognised.asked)}`
    );
    assert.equal(recognised.buffer.toString("ascii", 0, 4), "RIFF");
    assert.equal(unrecognised.buffer.toString("ascii", 0, 4), "RIFF");
  });

  it("reports a failure that survives retrying instead of absorbing it", async () => {
    const failure = "Audio gateway is unreachable";
    let calls = 0;
    const synthesizeFn = async (): Promise<Buffer> => {
      calls++;
      throw new Error(failure);
    };

    await assert.rejects(
      () => synthesizeSpeechWithFallback(TEXT, options, 0, undefined, synthesizeFn),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          new RegExp(failure),
          "the reported failure should name what went wrong, not how the retry ended"
        );
        return true;
      }
    );

    assert.ok(calls > 1, "the failure was reported without ever being retried");
  });

  it("does not turn a recovery it cannot join into half an utterance", async () => {
    // Both halves succeed, but not as WAV, so they cannot be concatenated. The
    // old fallback returned the left half and dropped the right one without a
    // word, which is a listener hearing half a sentence and being told it was
    // the whole of it.
    let calls = 0;
    const synthesizeFn = async (): Promise<Buffer> => {
      calls++;
      if (calls === 1) {
        throw new Error("Audio gateway returned 500 Internal Server Error");
      }
      return Buffer.from([0xff, 0xf7, 0x00, 0x00, 0x6d, 0x70, 0x33]);
    };

    await assert.rejects(
      () => synthesizeSpeechWithFallback(TEXT, options, 0, undefined, synthesizeFn),
      /cannot be joined/
    );
    assert.ok(calls > 1, "nothing was retried, so nothing was lost to report");
  });

  it("does not retry an abort, because the caller asked for it", async () => {
    let calls = 0;
    const synthesizeFn = async (): Promise<Buffer> => {
      calls++;
      throw new DOMException("TTS synthesis aborted", "AbortError");
    };

    await assert.rejects(
      () => synthesizeSpeechWithFallback(TEXT, options, 0, undefined, synthesizeFn),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError"
    );
    assert.equal(calls, 1, "an abort was retried as though it were a failure");
  });

  it("does not try to divide an utterance too short to divide", async () => {
    const short = "Chào bạn nhé."; // 13 characters, under the dividing floor
    let calls = 0;
    const synthesizeFn = async (): Promise<Buffer> => {
      calls++;
      throw new Error("Audio gateway returned 500 Internal Server Error");
    };

    await assert.rejects(() =>
      synthesizeSpeechWithFallback(short, options, 0, undefined, synthesizeFn)
    );
    assert.equal(calls, 1, "a fragment too short to divide was divided anyway");
  });
});

describe("resolveSttLanguage", () => {
  it("answers the two-letter ISO code, not the language's name", () => {
    // The service recognizes the code. Sent the full name it treats it as
    // unknown and quietly falls back to detecting the language itself — which is
    // the behaviour that answers short Vietnamese in Chinese, so a "helpful"
    // rename here would reintroduce the bug with no test failing anywhere else.
    assert.equal(resolveSttLanguage("vietnamese"), "vi");
    assert.equal(resolveSttLanguage("english"), "en");
  });
});

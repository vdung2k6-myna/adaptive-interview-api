import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  numberToVietnameseWords,
  normalizeNumbersForKokoro,
  normalizeTextForEngine,
  splitForTTS,
  stripMarkdown,
  synthesizeLongText,
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

describe("splitForTTS", () => {
  it("avoids splitting a number from its noun", () => {
    const chunks = splitForTTS(
      "Bạn đã thực hiện những công việc chăm sóc cụ thể nào cho 5 người lớn tuổi đó?"
    );
    assert.ok(!chunks.some((c) => /\b5$/.test(c)), `unexpected chunk ending in 5: ${JSON.stringify(chunks)}`);
  });

  it("splits at Vietnamese phrase starters when they produce natural chunks", () => {
    const chunks = splitForTTS(
      "Bạn đã thực hiện những công việc chăm sóc cụ thể nào cho 5 người lớn tuổi đó?"
    );
    assert.equal(chunks[0], "Bạn đã thực hiện những công việc chăm sóc");
    assert.equal(
      chunks[1],
      "cụ thể nào cho 5 người lớn tuổi đó?"
    );
  });

  it("prefers commas over nearby spaces", () => {
    const chunks = splitForTTS(
      "Trong dự án trước, bạn đã xử lý như thế nào với các tình huống khó khăn?"
    );
    assert.equal(
      chunks[0],
      "Trong dự án trước,"
    );
  });

  it("does not produce tiny chunks for early punctuation", () => {
    const chunks = splitForTTS(
      "A, very long sentence that goes on and on and should not be split right after the first letter because that would be silly."
    );
    assert.ok(chunks[0].length >= 20);
  });

  it("keeps short text as a single chunk", () => {
    assert.deepEqual(splitForTTS("Bạn có 3 năm kinh nghiệm?"), [
      "Bạn có 3 năm kinh nghiệm?",
    ]);
  });

  it("handles a long question with multiple natural breaks", () => {
    const chunks = splitForTTS(
      "Trong dự án vừa rồi, bạn đã sử dụng những công cụ nào để quản lý cơ sở dữ liệu và đảm bảo hiệu năng?"
    );
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.length <= 60 || /^\d/.test(c.slice(-1))));
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

  it("splits at commas before strong phrase starters", () => {
    const chunks = splitForTTS(
      "Khi gặp lỗi production, bạn thường debug như thế nào và bạn sẽ ưu tiên điều gì trước tiên?"
    );
    assert.ok(chunks[0].endsWith(","), `expected first chunk to end with comma: ${JSON.stringify(chunks)}`);
  });

  it("handles the user's long example with examples list", () => {
    const sentence =
      "Bạn đã thực hiện những công việc chăm sóc cụ thể nào cho 5 người lớn tuổi đó (ví dụ: tắm rửa, nấu ăn, nhắc uống thuốc, đưa đi khám bệnh)?";
    const chunks = splitForTTS(sentence);
    console.log("chunks:", JSON.stringify(chunks));
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
    const text =
      "Trong dự án vừa rồi, bạn đã sử dụng những công cụ nào để quản lý cơ sở dữ liệu và đảm bảo hiệu năng?";
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

  it("synthesizes chunks concurrently while preserving order", async () => {
    const text =
      "Trong dự án vừa rồi, bạn đã sử dụng những công cụ nào để quản lý cơ sở dữ liệu và đảm bảo hiệu năng?";
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

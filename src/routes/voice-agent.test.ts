import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { createVoiceAgentRouter, type VoiceAgentDeps } from "./voice-agent";
import { DEFAULT_PREFETCH_TOP_K } from "../lib/prefetch";
import type { KnowledgeChunk, KnowledgeSearchOutcome, SearchOptions } from "../lib/knowledge";
import { SentenceExtractor } from "../lib/audio/sentence-extractor";

interface SearchCall {
  query: string;
  topK?: number;
  collections?: string[];
  /** The options the route passed with the search, or `undefined` when it passed
   * none — which is every generating turn's search, and is what keeps that
   * request body byte-identical to what it was (design.md D5). */
  options?: SearchOptions;
}

interface Harness {
  deps: Partial<VoiceAgentDeps>;
  /** Every search the route issued, in order. */
  searches: SearchCall[];
  /** Every message array the route gave the LLM, flattened to text. */
  prompts: string[];
  /** Every message array the route gave the *non-streaming* generate — the
   * fallback a cloud model with empty streaming content triggers. Separate from
   * `prompts` so "no model was asked" can be asserted over both. */
  nonStreaming: string[];
  /** Everything the route logged, so a test can assert on a drop or a query. */
  logs: string[];
  /** What the route did, in order — `"search"` and `"transcribe"` — so a test
   * can assert that the session's speculative search is issued before the turn
   * awaits transcription rather than merely issued (4.1). */
  events: string[];
  /** The text of every chunk the route asked to synthesize, in order — what the
   * turn actually spoke, which is not the same claim as what it emitted. */
  synthCalls: string[];
  /** Every transcription the route asked for, with the arguments it passed. The
   * language has to reach the transcriber, and "the route knows the language" is
   * not the same claim as "the transcriber was told it". */
  transcribeCalls: Array<{ language: string | undefined }>;
}

/** One turn's worth of history, which is what makes a turn *not* a session's
 * first: a session's first turn is the one whose `history` is empty, and it is
 * the only turn that issues the session's topic-scoped search (D4). */
const LATER_TURN = JSON.stringify([
  { role: "user", content: "an earlier question" },
  { role: "agent", content: "an earlier answer" },
]);

/** A search's answer, or a promise of one, so a test can make one resolve later. */
type Reply =
  | KnowledgeSearchOutcome
  | Promise<KnowledgeSearchOutcome>
  | ((call: SearchCall) => KnowledgeSearchOutcome | Promise<KnowledgeSearchOutcome>);

/**
 * Drive the route without a live doc-etl-api, ollama, or audio service. The
 * stream is empty on purpose: the route then falls back to the stubbed
 * non-streaming generate, gets "", and emits no sentence — so the turn
 * completes with no TTS and `done` is the last event (design.md D10).
 *
 * `reply` is one outcome for every search, or a function of the call when a test
 * needs the prefetch and a later fresh search to return different chunks.
 * `neverSettles` names the calls whose search must hang, which is how 4.1 proves
 * the success path cannot block on the session's speculative search.
 *
 * `stream` overrides the empty default for the one thing it makes unreachable:
 * the TTS path. A test that drives a non-empty stream gets a turn that extracts
 * sentences, synthesizes chunks, and ends on the extractor's `finalize` tail.
 */
function harness(
  reply: Reply = { ok: true, chunks: [] },
  settings: {
    neverSettles?: (call: SearchCall) => boolean;
    /** The tokens the fake LLM streams, in order. */
    stream?: string[];
    /** What `getFullText()` answers. Defaults to the streamed tokens joined, so
     * `finalize` sees the same text the turn streamed. */
    fullText?: string;
    /** The audio for one chunk, so a test can make one fail or tag a buffer with
     * the text it belongs to. Defaults to the empty buffer the route then
     * base64-encodes to `""`, which is what the existing tests expect. */
    synthesize?: (chunk: string, call: number) => Buffer | Promise<Buffer>;
    /** What the fake STT hears. Defaults to words; `""` is a silent recording,
     * which the client reports as an empty transcript rather than an error. */
    transcription?: string;
  } = {}
): Harness {
  const searches: SearchCall[] = [];
  const prompts: string[] = [];
  const nonStreaming: string[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const synthCalls: string[] = [];
  const transcribeCalls: Array<{ language: string | undefined }> = [];
  const tokens = settings.stream ?? [];
  const fullText = settings.fullText ?? tokens.join("");

  return {
    searches,
    prompts,
    nonStreaming,
    logs,
    events,
    synthCalls,
    transcribeCalls,
    deps: {
      searchKnowledge: async (query, topK, collections, options) => {
        const call = { query, topK, collections, options };
        searches.push(call);
        events.push("search");
        if (settings.neverSettles?.(call)) {
          return new Promise<KnowledgeSearchOutcome>(() => {});
        }
        return await (typeof reply === "function" ? reply(call) : reply);
      },
      transcribeAudio: async (_audioPath, _model, language) => {
        events.push("transcribe");
        transcribeCalls.push({ language });
        return { text: settings.transcription ?? "transcribed words", confidence: 0.9 };
      },
      generateChatResponseStream: (options) => {
        prompts.push(options.messages.map((m) => m.content).join("\n---\n"));
        return {
          stream: new ReadableStream<string>({
            start(controller) {
              for (const token of tokens) controller.enqueue(token);
              controller.close();
            },
          }),
          getFullText: () => fullText,
        };
      },
      generateChatResponse: async (options) => {
        nonStreaming.push(options.messages.map((m) => m.content).join("\n---\n"));
        return "";
      },
      synthesizeSpeechWithFallback: async (chunk) => {
        const call = synthCalls.length;
        synthCalls.push(chunk);
        return await (settings.synthesize?.(chunk, call) ?? Buffer.alloc(0));
      },
    },
  };
}

/** The two endpoints this router serves, as bound for one test. */
interface Endpoints {
  /** POST here to submit a turn. */
  stream: string;
  /** POST here to prefetch a text turn's knowledge. */
  prefetch: string;
}

/** Mount the router on a bare app, bound to an ephemeral port. */
async function withServer(
  deps: Partial<VoiceAgentDeps>,
  fn: (api: Endpoints) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/voice-agent", createVoiceAgentRouter(deps));

  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object", "expected the app to bind a port");
  const base = `http://127.0.0.1:${address.port}/api/voice-agent`;

  try {
    await fn({ stream: `${base}/stream`, prefetch: `${base}/prefetch` });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Run `fn` with the route's logging captured into the harness rather than
 * printed — it logs at length on every turn. */
async function captureConsole<T>(harnessed: Harness, fn: () => Promise<T>): Promise<T> {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => {
    harnessed.logs.push(args.map(String).join(" "));
  };
  console.log = capture as typeof console.log;
  console.warn = capture as typeof console.warn;
  console.error = capture as typeof console.error;

  try {
    return await fn();
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
}

/** POST a JSON body and return the response. */
async function postJson(
  url: string,
  harnessed: Harness,
  body: Record<string, unknown>
): Promise<Response> {
  return captureConsole(harnessed, () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemPrompt: "You are a tutor.",
        language: "english",
        ...body,
      }),
    })
  );
}

/**
 * Submit one turn as recorded audio, which is the only path that makes the route
 * await transcription — and so the only one that can show the session's
 * topic-scoped search being issued *before* that await (4.1).
 */
async function sendAudioTurn(
  url: string,
  harnessed: Harness,
  body: Record<string, unknown> = {}
): Promise<string> {
  const form = new FormData();
  form.append("systemPrompt", "You are a tutor.");
  form.append("language", typeof body.language === "string" ? body.language : "english");
  form.append("audio", new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/wav" }), "turn.wav");
  for (const [key, value] of Object.entries(body)) {
    if (key === "language") continue; // already appended, and a repeated field is not the same request
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  const response = await captureConsole(harnessed, () =>
    fetch(url, { method: "POST", body: form })
  );
  assert.equal(response.status, 200);
  return await response.text();
}

/** Submit one turn and return its SSE body. */
async function sendTurn(
  url: string,
  harnessed: Harness,
  body: Record<string, unknown> = {}
): Promise<string> {
  const response = await postJson(url, harnessed, body);
  assert.equal(response.status, 200);
  return await response.text();
}

/**
 * Issue a prefetch and return its `prefetchId`. `null` is the route's ordinary
 * "nothing to reuse" answer, so it is returned rather than asserted against.
 */
async function sendPrefetch(
  url: string,
  harnessed: Harness,
  body: Record<string, unknown> = {}
): Promise<string | null> {
  const response = await postJson(url, harnessed, body);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { prefetchId?: string | null };
  return payload.prefetchId ?? null;
}

describe("POST /api/voice-agent/stream — the knowledge turn", () => {
  it("completes a turn with no prefetch id, searching the submitted text itself", async () => {
    const h = harness();

    await withServer(h.deps, async (api) => {
      const sse = await sendTurn(api.stream, h, {
        text: "How do I practice a sword form?",
        // A later turn of a session: the session's one speculative search belongs
        // to its first topical turn (4.x), and this test is about the turn's own.
        history: LATER_TURN,
        enabledTopics: ["Truyện kiếm hiệp"],
      });

      assert.match(sse, /event: done/, "the turn must run to completion");
      assert.equal(h.searches.length, 1, "one turn, one search — the turn's own");
      assert.equal(h.searches[0].query, "How do I practice a sword form?");
      assert.deepEqual(h.searches[0].collections, ["truyen-kiem-hiep"]);
    });
  });

  it("searches the user's text and carries none of the topic labels", async () => {
    const h = harness();

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, {
        text: "làm sao để luyện kiếm",
        history: LATER_TURN,
        enabledTopics: ["Truyện kiếm hiệp"],
      });

      assert.equal(h.searches.length, 1);
      assert.equal(
        h.searches[0].query,
        "làm sao để luyện kiếm",
        "the query is the user's input, not the input prefixed with a topic"
      );
      assert.ok(
        !h.searches[0].query.includes("Truyện kiếm hiệp"),
        "a topic label must not leak into the query text — it scopes via collections (D3)"
      );
      assert.deepEqual(h.searches[0].collections, ["truyen-kiem-hiep"]);
    });
  });

  it("scopes to only the labels that fold to a collection name", async () => {
    const h = harness();

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, {
        text: "a question",
        history: LATER_TURN,
        enabledTopics: ["Truyện kiếm hiệp", "!!!", "Kiếm hiệp"],
      });

      assert.deepEqual(
        h.searches[0].collections,
        ["truyen-kiem-hiep", "kiem-hiep"],
        "labels folding to nothing are dropped and duplicates collapse"
      );
    });
  });

  it("sends no search and no knowledge section when every label folds away", async () => {
    const h = harness();

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, { text: "a question", enabledTopics: ["!!!"] });

      assert.equal(h.searches.length, 0, "no collection to scope by, so no search");
      assert.equal(h.prompts.length, 1);
      assert.ok(
        !h.prompts[0].includes("Relevant knowledge:"),
        "a turn with no usable scope must not claim knowledge"
      );
      assert.ok(
        h.logs.some((line) => line.includes("Dropped") && line.includes("!!!")),
        `the dropped label must be logged, got: ${JSON.stringify(h.logs)}`
      );
    });
  });

  it("sends no search at all when no topics are enabled", async () => {
    // Both shapes the contract allows for "no topics": the field omitted and the
    // field empty. Neither may issue any search — the turn's own or the session's
    // topic-scoped one (6.2).
    for (const topics of [undefined, [] as string[]]) {
      const h = harness();

      await withServer(h.deps, async (api) => {
        await sendTurn(api.stream, h, {
          text: "a question",
          ...(topics ? { enabledTopics: topics } : {}),
        });

        assert.equal(h.searches.length, 0, "no turn search and no topic-scoped search");
        assert.ok(!h.prompts[0].includes("Relevant knowledge:"));
      });
    }
  });
});

describe("POST /api/voice-agent/stream — retrieved chunks in the prompt", () => {
  it("puts the chunks the search returned into the prompt, attributed", async () => {
    const chunks: KnowledgeChunk[] = [
      { text: "Hold the hilt with both hands.", source: "sword-guide.pdf" },
    ];
    const h = harness({ ok: true, chunks });

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, {
        text: "grip?",
        history: LATER_TURN,
        enabledTopics: ["Truyện kiếm hiệp"],
      });

      assert.ok(h.prompts[0].includes("Relevant knowledge:"));
      assert.ok(h.prompts[0].includes("[sword-guide.pdf] Hold the hilt with both hands."));
    });
  });

  it("claims no knowledge when the search failed", async () => {
    const h = harness({ ok: false, reason: "server_error" });

    await withServer(h.deps, async (api) => {
      const sse = await sendTurn(api.stream, h, {
        text: "grip?",
        history: LATER_TURN,
        enabledTopics: ["Truyện kiếm hiệp"],
      });

      assert.match(sse, /event: done/, "a failed search must not break the turn");
      assert.ok(
        !h.prompts[0].includes("Relevant knowledge:"),
        "a failed search contributes no chunks"
      );
    });
  });

  it("treats a successful empty result as an answer, not a failure", async () => {
    const h = harness({ ok: true, chunks: [] });

    await withServer(h.deps, async (api) => {
      const sse = await sendTurn(api.stream, h, {
        text: "something out of scope",
        history: LATER_TURN,
        enabledTopics: ["Truyện kiếm hiệp"],
      });

      assert.match(sse, /event: done/);
      assert.equal(h.searches.length, 1);
      assert.ok(!h.prompts[0].includes("Relevant knowledge:"));
    });
  });

  it("carries the directive into the prompt alongside the chunks", async () => {
    const chunks: KnowledgeChunk[] = [
      { text: "Hold the hilt with both hands.", source: "sword-guide.pdf" },
    ];
    const h = harness({ ok: true, chunks });

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, {
        text: "grip?",
        history: LATER_TURN,
        enabledTopics: ["Truyện kiếm hiệp"],
      });

      assert.match(
        h.prompts[0],
        /base your reply on the material above when it is relevant/i,
        `a turn that retrieved chunks must direct the model to use them; got ${h.prompts[0]}`
      );
    });
  });

  it("carries no directive on a turn that has no chunks", async () => {
    // The three ways a turn reaches the prompt with nothing: no topics at all, a
    // successful empty result, and a search that failed to obtain a result. The
    // directive rides inside the section, so none of them may carry it — this is
    // the route-level half of the invariant the unit test pins (design D1).
    const cases: Array<{
      label: string;
      reply: KnowledgeSearchOutcome;
      topics?: string[];
    }> = [
      { label: "no topics", reply: { ok: true, chunks: [] } },
      { label: "empty result", reply: { ok: true, chunks: [] }, topics: ["Truyện kiếm hiệp"] },
      { label: "failed search", reply: { ok: false, reason: "timeout" }, topics: ["Truyện kiếm hiệp"] },
    ];

    for (const c of cases) {
      const h = harness(c.reply);

      await withServer(h.deps, async (api) => {
        await sendTurn(api.stream, h, {
          text: "grip?",
          history: LATER_TURN,
          ...(c.topics ? { enabledTopics: c.topics } : {}),
        });

        assert.ok(
          !/base your reply on the material/i.test(h.prompts[0]),
          `${c.label}: a turn with no chunks must carry no directive; got ${h.prompts[0]}`
        );
        assert.ok(
          !h.prompts[0].includes("Relevant knowledge:"),
          `${c.label}: and no knowledge section`
        );
      });
    }
  });
});

describe("POST /api/voice-agent/stream — request validation", () => {
  it("refuses a turn with no system prompt before any search", async () => {
    const h = harness();

    await withServer(h.deps, async (api) => {
      const sse = await sendTurn(api.stream, h, {
        systemPrompt: "",
        text: "a question",
        enabledTopics: ["Truyện kiếm hiệp"],
      });

      assert.match(sse, /event: error/);
      assert.equal(h.searches.length, 0, "nothing must be spent on an invalid turn");
    });
  });

  it("ends a turn whose audio transcribed to nothing, before any search or LLM call", async () => {
    // Silence used to arrive as a throw from the STT client, so it read as a dead
    // service: the turn fell into the outer catch and the user was shown "STT
    // returned empty transcription". Heard nothing is an answer, and the turn it
    // belongs to has nothing to ground, answer or speak — so it must end on
    // purpose, here, rather than be handed to the LLM as a history with no new
    // question in it (which the agent would answer all over again).
    const h = harness({ ok: true, chunks: [] }, { transcription: "" });

    await withServer(h.deps, async (api) => {
      const sse = await sendAudioTurn(api.stream, h, { history: LATER_TURN });
      const events = parseSse(sse);

      assert.deepEqual(
        events.map((event) => event.event),
        ["notice"],
        "one notice and nothing else — no user turn, no chunks, no done, no error"
      );
      assert.equal(events[0].data.code, "no_speech");
      assert.equal(h.searches.length, 0, "there is no question to search for");
      assert.equal(h.prompts.length, 0, "the LLM must not be asked to answer nothing");
      assert.equal(h.synthCalls.length, 0, "and there is nothing to speak");
      assert.ok(
        !h.logs.some((line) => line.includes("Unexpected error")),
        `a silent turn is an outcome, not an unhandled error — logged: ${h.logs.join(" | ")}`
      );
    });
  });

  it("pins the transcriber to the turn's language instead of leaving it to detect one", async () => {
    // Left to detect, the transcriber answers short or quiet Vietnamese in
    // Chinese — measured on the gadget, where a turn whose transcript was
    // "你可就别别说这话了。" was reproduced deterministically from the captured
    // audio and came back Vietnamese only when the same bytes were sent with
    // `language=vi`. The tutor personas then correct the person's "Chinese", so
    // the device lectures someone who has only ever spoken Vietnamese. The turn
    // carries the language; the transcriber is the one thing that has to be told.
    const h = harness();

    await withServer(h.deps, async (api) => {
      await sendAudioTurn(api.stream, h, { language: "vietnamese", history: LATER_TURN });
      await sendAudioTurn(api.stream, h, { language: "english", history: LATER_TURN });

      assert.deepEqual(
        h.transcribeCalls.map((call) => call.language),
        ["vi", "en"],
        "the ISO code the service recognizes — the full language name silently " +
          "falls back to detection, which is the bug being guarded here"
      );
    });
  });
});

describe("POST /api/voice-agent/prefetch — holding a result for a turn not yet submitted", () => {
  const PREFETCHED: KnowledgeChunk[] = [
    { text: "Hold the hilt with both hands.", source: "sword-guide.pdf" },
  ];
  const FRESH: KnowledgeChunk[] = [
    { text: "Breathe before the first cut.", source: "form-guide.pdf" },
  ];
  /** The one topic the live corpus serves; see 2.6's note in tasks.md. */
  const TOPICS = ["Truyện kiếm hiệp"];

  /**
   * The prefetch's own search yields PREFETCHED and every search after it yields
   * FRESH. Keyed on which search it is rather than on the query, so two turns
   * submitting the same text stay distinguishable.
   */
  function prefetchThenFresh(): (call: SearchCall) => KnowledgeSearchOutcome {
    let issued = 0;
    return () => (++issued === 1 ? { ok: true, chunks: PREFETCHED } : { ok: true, chunks: FRESH });
  }

  it("holds the result its search returned and identifies it", async () => {
    const h = harness({ ok: true, chunks: PREFETCHED });

    await withServer(h.deps, async (api) => {
      const id = await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: TOPICS });

      assert.ok(id, "a prefetch that yielded a result must be identified");
      assert.equal(typeof id, "string");
      assert.equal(h.searches.length, 1);
      assert.equal(h.searches[0].query, "grip?", "the prefetch searches the typed input");
      assert.deepEqual(h.searches[0].collections, ["truyen-kiem-hiep"]);
    });
  });

  it("asks for each hit's section when the prefetch declares a material-reply persona", async () => {
    const h = harness({ ok: true, chunks: PREFETCHED });

    await withServer(h.deps, async (api) => {
      await sendPrefetch(api.prefetch, h, {
        text: "grip?",
        enabledTopics: TOPICS,
        answerMode: "material",
      });
      await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: TOPICS });

      assert.deepEqual(
        h.searches[0].options,
        { expand: "section" },
        "a hold meant for a material turn must carry the section that turn will speak (D6)"
      );
      assert.equal(
        h.searches[1].options,
        undefined,
        "a hold for the generating path asks for nothing extra, so its request is unchanged (D5)"
      );
    });
  });

  it("issues no prefetch when no topic resolves to a collection", async () => {
    const h = harness({ ok: true, chunks: PREFETCHED });

    await withServer(h.deps, async (api) => {
      const id = await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: ["!!!"] });

      assert.equal(id, null);
      assert.equal(h.searches.length, 0, "nothing to scope a search by, so no search");
    });
  });

  it("issues no prefetch when no topics are enabled", async () => {
    // The other half of the no-usable-scope rule, and the one a client reaches
    // without trying: a prefetch request with the field omitted or empty must do
    // nothing at all, not search unscoped (6.2).
    for (const topics of [undefined, [] as string[]]) {
      const h = harness({ ok: true, chunks: PREFETCHED });

      await withServer(h.deps, async (api) => {
        const id = await sendPrefetch(api.prefetch, h, {
          text: "grip?",
          ...(topics ? { enabledTopics: topics } : {}),
        });

        assert.equal(id, null, `nothing to reuse for ${JSON.stringify(topics)}`);
        assert.equal(h.searches.length, 0, "and nothing to search for");
      });
    }
  });

  it("reuses a matching prefetch and issues no second search", async () => {
    const h = harness({ ok: true, chunks: PREFETCHED });

    await withServer(h.deps, async (api) => {
      const id = await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: TOPICS });
      const sse = await sendTurn(api.stream, h, {
        text: "grip?",
        prefetchId: id,
        history: LATER_TURN,
        enabledTopics: TOPICS,
      });

      assert.match(sse, /event: done/);
      assert.equal(h.searches.length, 1, "the prefetch is the turn's knowledge — no second search");
      assert.ok(
        h.prompts[0].includes("[sword-guide.pdf] Hold the hilt with both hands."),
        "the prompt must carry the prefetched chunks"
      );
    });
  });

  it("discards a prefetch whose input differs and searches fresh", async () => {
    const h = harness(prefetchThenFresh());

    await withServer(h.deps, async (api) => {
      const id = await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: TOPICS });
      const sse = await sendTurn(api.stream, h, {
        text: "grip? I meant the other grip",
        prefetchId: id,
        history: LATER_TURN,
        enabledTopics: TOPICS,
      });

      assert.match(sse, /event: done/);
      assert.equal(h.searches.length, 2, "the discarded prefetch and the turn's own search");
      assert.equal(h.searches[1].query, "grip? I meant the other grip");
      assert.ok(h.prompts[0].includes("[form-guide.pdf] Breathe before the first cut."));
      assert.ok(
        !h.prompts[0].includes("Hold the hilt with both hands."),
        "no prefetched chunk may reach a turn it does not match"
      );
    });
  });

  it("reuses a prefetch once, so a second turn naming the same id searches fresh", async () => {
    const h = harness(prefetchThenFresh());

    await withServer(h.deps, async (api) => {
      const id = await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: TOPICS });
      await sendTurn(api.stream, h, {
        text: "grip?",
        prefetchId: id,
        history: LATER_TURN,
        enabledTopics: TOPICS,
      });
      await sendTurn(api.stream, h, {
        text: "grip?",
        prefetchId: id,
        history: LATER_TURN,
        enabledTopics: TOPICS,
      });

      assert.equal(h.searches.length, 2, "the prefetch served one turn, and only one");
      assert.equal(h.prompts.length, 2);
      assert.ok(h.prompts[0].includes("Hold the hilt with both hands."));
      assert.ok(
        h.prompts[1].includes("Breathe before the first cut."),
        "the second turn searched for itself rather than reusing the spent prefetch"
      );
    });
  });

  it("searches as before when a turn names no id or an unknown one", async () => {
    const h = harness({ ok: true, chunks: FRESH });

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, { text: "grip?", history: LATER_TURN, enabledTopics: TOPICS });
      await sendTurn(api.stream, h, {
        text: "grip?",
        prefetchId: "6f1c3d1e-0000-4000-8000-000000000000",
        history: LATER_TURN,
        enabledTopics: TOPICS,
      });

      assert.equal(h.searches.length, 2, "each turn searched for itself");
      assert.equal(h.prompts.length, 2);
      assert.ok(h.prompts[1].includes("[form-guide.pdf] Breathe before the first cut."));
    });
  });

  it("treats a prefetched empty result as an answer, not a failure", async () => {
    const h = harness({ ok: true, chunks: [] });

    await withServer(h.deps, async (api) => {
      const id = await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: TOPICS });
      assert.ok(id, "an empty answer is not a failure, so it is identified (D5)");

      const sse = await sendTurn(api.stream, h, {
        text: "grip?",
        prefetchId: id,
        history: LATER_TURN,
        enabledTopics: TOPICS,
      });

      assert.match(sse, /event: done/);
      assert.equal(h.searches.length, 1, "an authoritative empty answer is not re-asked");
      assert.ok(
        !h.prompts[0].includes("Relevant knowledge:"),
        "an empty result adds no knowledge section"
      );
    });
  });

  it("returns no id for a prefetch that failed, so its turn searches fresh", async () => {
    for (const reason of ["timeout", "unreachable", "server_error", "rejected"] as const) {
      const h = harness({ ok: false, reason });

      await withServer(h.deps, async (api) => {
        const id = await sendPrefetch(api.prefetch, h, { text: "grip?", enabledTopics: TOPICS });
        assert.equal(id, null, `a ${reason} must not be identified for reuse`);

        // A null id is what the client holds, so the turn it was issued for
        // submits with none and searches as it would with no prefetch at all.
        const sse = await sendTurn(api.stream, h, {
          text: "grip?",
          history: LATER_TURN,
          enabledTopics: TOPICS,
        });

        assert.match(sse, /event: done/);
        assert.equal(h.searches.length, 2, "the failed prefetch, then the turn's own search");
        assert.equal(h.searches[1].query, "grip?");
      });
    }
  });
});

describe("POST /api/voice-agent/stream — the session's topic-scoped fallback", () => {
  const TOPICS = ["Truyện kiếm hiệp"];
  /** The topic-scoped query is the labels joined, which is what makes it
   * distinguishable from every turn's own query — the user's input (4.3). */
  const TOPIC_QUERY = "Truyện kiếm hiệp";
  const SESSION_CHUNKS: KnowledgeChunk[] = [
    { text: "Session-scoped background.", source: "session.pdf" },
  ];
  const TURN_CHUNKS: KnowledgeChunk[] = [{ text: "The turn's own answer.", source: "turn.pdf" }];

  /**
   * The session's speculative search answers with `topic`; every other search
   * answers with `turn`. `turnDelayMs` makes a turn's own search settle after the
   * speculative one has — the order the two are issued in, and what a fallback
   * read depends on.
   */
  function reply(
    outcomes: { topic: KnowledgeSearchOutcome; turn: KnowledgeSearchOutcome },
    options: { turnDelayMs?: number } = {}
  ): Reply {
    return async (call: SearchCall) => {
      if (call.query === TOPIC_QUERY) return outcomes.topic;
      if (options.turnDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.turnDelayMs));
      }
      return outcomes.turn;
    };
  }

  const topicCalls = (h: Harness) => h.searches.filter((call) => call.query === TOPIC_QUERY);

  it("issues it before transcription and never awaits it", async () => {
    const h = harness(
      reply({ topic: { ok: true, chunks: SESSION_CHUNKS }, turn: { ok: true, chunks: TURN_CHUNKS } }),
      { neverSettles: (call) => call.query === TOPIC_QUERY }
    );

    await withServer(h.deps, async (api) => {
      const sse = await sendAudioTurn(api.stream, h, { enabledTopics: TOPICS });

      assert.match(sse, /event: done/, "a hanging speculative search must not delay the turn");
      assert.ok(
        h.events.indexOf("search") < h.events.indexOf("transcribe"),
        "the session's search must be issued before the turn awaits transcription"
      );
      assert.deepEqual(topicCalls(h)[0]?.collections, ["truyen-kiem-hiep"]);
      assert.ok(
        h.prompts[0].includes(TURN_CHUNKS[0].text),
        "the turn completes with its own search's chunks"
      );
    });
  });

  it("issues it once per session", async () => {
    const h = harness(
      reply({ topic: { ok: true, chunks: SESSION_CHUNKS }, turn: { ok: true, chunks: TURN_CHUNKS } })
    );

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, { text: "the first turn", enabledTopics: TOPICS });
      await sendTurn(api.stream, h, {
        text: "a later turn",
        history: LATER_TURN,
        enabledTopics: TOPICS,
      });

      assert.equal(topicCalls(h).length, 1, "one session, one topic-scoped search");
      assert.equal(h.searches.filter((call) => call.query === "a later turn").length, 1);
    });
  });

  it("queries it with the enabled labels joined", async () => {
    const h = harness();

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, {
        text: "a question",
        enabledTopics: ["Truyện kiếm hiệp", "Kiếm hiệp", "!!!"],
      });

      const call = h.searches.find((c) => c.collections?.length === 2);
      assert.ok(call, "the session's search is the one scoped to both collections");
      assert.equal(
        call.query,
        "Truyện kiếm hiệp Kiếm hiệp",
        "the labels joined, with the one that folded to nothing left out"
      );
      assert.deepEqual(call.collections, ["truyen-kiem-hiep", "kiem-hiep"]);
    });
  });

  it("issues no topic-scoped search on a turn with no enabled topics", async () => {
    const h = harness();

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, { text: "a question" });

      assert.equal(h.searches.length, 0, "no topics, no search of any kind");
    });
  });

  it("falls back to the session's chunks when the turn's own search fails", async () => {
    const h = harness(
      reply(
        { topic: { ok: true, chunks: SESSION_CHUNKS }, turn: { ok: false, reason: "unreachable" } },
        { turnDelayMs: 5 }
      )
    );

    await withServer(h.deps, async (api) => {
      const sse = await sendTurn(api.stream, h, { text: "grip?", enabledTopics: TOPICS });

      assert.match(sse, /event: done/);
      assert.ok(
        h.prompts[0].includes(`[session.pdf] ${SESSION_CHUNKS[0].text}`),
        "a turn whose own search failed answers from the session's topic-scoped chunks"
      );
    });
  });

  it("falls back to nothing when the session holds no chunks", async () => {
    const h = harness(
      reply(
        {
          topic: { ok: false, reason: "server_error" },
          turn: { ok: false, reason: "unreachable" },
        },
        { turnDelayMs: 5 }
      )
    );

    await withServer(h.deps, async (api) => {
      const sse = await sendTurn(api.stream, h, { text: "grip?", enabledTopics: TOPICS });

      assert.match(sse, /event: done/);
      assert.ok(!h.prompts[0].includes("Relevant knowledge:"));
    });
  });

  it("does not draw on them when the service refused the turn's search", async () => {
    const h = harness(
      reply(
        { topic: { ok: true, chunks: SESSION_CHUNKS }, turn: { ok: false, reason: "rejected" } },
        { turnDelayMs: 5 }
      )
    );

    await withServer(h.deps, async (api) => {
      const sse = await sendTurn(api.stream, h, { text: "grip?", enabledTopics: TOPICS });

      assert.match(sse, /event: done/);
      assert.ok(
        !h.prompts[0].includes(SESSION_CHUNKS[0].text),
        "a refusal is our own defect, so it is not papered over with the session's chunks (D9)"
      );
      assert.ok(!h.prompts[0].includes("Relevant knowledge:"));
    });
  });

  it("never mixes them into a turn whose own search succeeded", async () => {
    const h = harness(
      reply({ topic: { ok: true, chunks: SESSION_CHUNKS }, turn: { ok: true, chunks: TURN_CHUNKS } })
    );

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, { text: "grip?", enabledTopics: TOPICS });

      assert.ok(h.prompts[0].includes(TURN_CHUNKS[0].text));
      assert.ok(
        !h.prompts[0].includes(SESSION_CHUNKS[0].text),
        "the fallback is a fallback, not a second source"
      );
    });
  });

  it("does not use chunks held for a different scope", async () => {
    const h = harness(
      reply(
        { topic: { ok: true, chunks: SESSION_CHUNKS }, turn: { ok: false, reason: "timeout" } },
        { turnDelayMs: 5 }
      )
    );

    await withServer(h.deps, async (api) => {
      // Turn 1 opens the session on one topic and holds its chunks.
      await sendTurn(api.stream, h, { text: "the first turn", enabledTopics: TOPICS });
      // Turn 2 enables a different topic, so its resolved collections are not the
      // ones the session's search was issued for.
      const sse = await sendTurn(api.stream, h, {
        text: "a later turn",
        history: LATER_TURN,
        enabledTopics: ["Kiếm hiệp"],
      });

      assert.match(sse, /event: done/);
      assert.ok(
        !h.prompts[1].includes(SESSION_CHUNKS[0].text),
        "a turn whose collections differ from the session's search gets no fallback"
      );
      assert.ok(!h.prompts[1].includes("Relevant knowledge:"));
    });
  });
});

/** One SSE event as it went over the wire. */
function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const field = (prefix: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(prefix))
          ?.slice(prefix.length) ?? "";
      return { event: field("event: "), data: JSON.parse(field("data: ")) };
    });
}

describe("POST /api/voice-agent/stream — the spoken chunk contract", () => {
  /** Two delimited sentences — the second long enough that the splitter must
   * break it into chunks — plus a closing fragment with no delimiter. That last
   * token is what makes the turn reach the second emit site after `finalize`
   * (`voice-agent.ts:404`), which no test in this file could reach while every
   * turn's stream was empty (design.md, task 1.3). */
  const TOKENS = [
    "First sentence here.",
    " Second sentence, long enough that the splitter has to break it into more than one chunk.",
    " And a closing fragment with no delimiter",
  ];
  const TAIL = "And a closing fragment with no delimiter";

  it("streams a text event before its chunks, numbering them across both emit sites", async () => {
    const h = harness(
      { ok: true, chunks: [] },
      { stream: TOKENS, synthesize: (chunk) => Buffer.from(`wav:${chunk}`) }
    );

    await withServer(h.deps, async (api) => {
      const events = parseSse(await sendTurn(api.stream, h));
      const chunks = events.filter((event) => event.event === "sentence");

      assert.match(
        events.map((event) => event.event).join(" "),
        /^(text( sentence)+ )+done$/,
        "each sentence's text event must precede that sentence's chunks, and done must close"
      );
      assert.deepEqual(
        chunks.map((event) => event.data.index),
        chunks.map((_, at) => at),
        "indices must run 0..n-1 across both emit sites, with no gap and no restart"
      );
      assert.deepEqual(
        chunks.map((event) => event.data.text),
        h.synthCalls,
        "each event must carry the chunk that was synthesized, in call order"
      );
      for (const { data } of chunks) {
        assert.equal(
          Buffer.from(data.audioData as string, "base64").toString("utf8"),
          `wav:${data.text}`,
          "audioData must be the buffer synthesized for this event's text"
        );
      }
      assert.ok(
        chunks.length > 3,
        `expected the long sentence to be split across chunks, got ${chunks.length}`
      );
      assert.equal(
        chunks.at(-1)?.data.text,
        TAIL,
        "the delimiter-less tail must still be spoken — that is the second emit site"
      );
    });
  });

  it("reports a failed chunk as null audio at its own index, and still reaches done", async () => {
    const h = harness(
      { ok: true, chunks: [] },
      {
        stream: TOKENS,
        synthesize: (chunk, call) => {
          if (call === 1) throw new Error("audio gateway refused this chunk");
          return Buffer.from(`wav:${chunk}`);
        },
      }
    );

    await withServer(h.deps, async (api) => {
      const events = parseSse(await sendTurn(api.stream, h));
      const chunks = events.filter((event) => event.event === "sentence");

      assert.deepEqual(
        chunks.map((event) => event.data.index),
        chunks.map((_, at) => at),
        "a failed chunk keeps its index instead of leaving a gap"
      );
      assert.equal(chunks[1].data.audioData, null, "the failure is reported, not omitted");
      assert.ok(
        chunks.slice(2).every((event) => typeof event.data.audioData === "string"),
        "every chunk after the failure still carries its audio"
      );
      assert.equal(h.synthCalls.length, chunks.length, "the turn keeps synthesizing after the failure");
      assert.equal(events.at(-1)?.event, "done", "one unpronounceable chunk must not end the turn");
      assert.ok(
        h.logs.some((line) => line.includes("TTS failed chunk 1")),
        `the skip must be reported, not silent — logged: ${h.logs.join(" | ")}`
      );
    });
  });

  it("emits every chunk's text and no audio, and synthesizes nothing, when the turn is muted", async () => {
    // `speak: "0"` is a client saying it will not play this turn. The turn must be
    // otherwise indistinguishable from a spoken one — same texts, same indices,
    // same `done` — because the transcript is the half a muted client still reads.
    const h = harness(
      { ok: true, chunks: [] },
      { stream: TOKENS, synthesize: (chunk) => Buffer.from(`wav:${chunk}`) }
    );

    await withServer(h.deps, async (api) => {
      const events = parseSse(await sendTurn(api.stream, h, { speak: "0" }));
      const chunks = events.filter((event) => event.event === "sentence");

      assert.equal(h.synthCalls.length, 0, "a muted turn must not ask the TTS service for anything");
      assert.ok(
        chunks.length > 3,
        `a muted turn must still reach every chunk — got ${chunks.length}, the spoken turn's is 4+`
      );
      assert.deepEqual(
        chunks.map((event) => event.data.index),
        chunks.map((_, at) => at),
        "the indices must be the ones a spoken turn's chunks would have had"
      );
      assert.ok(
        chunks.every((event) => event.data.audioData === null),
        "every chunk must be emitted with no audio rather than omitted"
      );
      assert.ok(
        chunks.every((event) => typeof event.data.text === "string" && event.data.text.length > 0),
        "the text is the half a muted turn keeps"
      );
      assert.equal(chunks.at(-1)?.data.text, TAIL, "the delimiter-less tail must still arrive");
      assert.equal(events.at(-1)?.event, "done", "a muted turn must close like any other");
      assert.ok(
        !h.logs.some((line) => line.includes("TTS failed")),
        `muting is not a failure, so nothing may be reported as one — logged: ${h.logs.join(" | ")}`
      );
    });
  });
});

describe("POST /api/voice-agent/stream — chunking is the extractor's chunking (D6)", () => {
  it("emits exactly the chunks the extractor produces for the same sentence", async () => {
    // D6 moves the split out of both callers and into the core, on the claim that
    // the core's `splitForTTS(clean)` is *the same split* the voice agent gets
    // today from `SentenceExtractor`. That claim is only checkable while the
    // extractor is still the one splitting, so pin it now: after 4.1 this same
    // assertion is what proves the move changed no chunk. `clean` is asserted
    // equal to the input because the core will be handed `clean`, not `raw`, so
    // the identity only transfers if the two are the same string.
    const sentence =
      "A single sentence long enough that the splitter has to break it into more than one chunk.";
    const [extracted] = new SentenceExtractor().feed(sentence);

    assert.equal(extracted.clean, sentence, "the pin transfers to the core only if `clean` is the input");
    assert.ok(extracted.chunks.length > 1, "the sentence must split, or the identity is trivial");

    const h = harness(
      { ok: true, chunks: [] },
      { stream: [sentence], synthesize: (chunk) => Buffer.from(`wav:${chunk}`) }
    );

    await withServer(h.deps, async (api) => {
      const events = parseSse(await sendTurn(api.stream, h));
      const spoken = events
        .filter((event) => event.event === "sentence")
        .map((event) => event.data.text);

      assert.deepEqual(spoken, extracted.chunks);
    });
  });
});

describe("POST /api/voice-agent/stream — the material turn", () => {
  /** The words the fixture hit's section holds, and so the text a material turn
   * answers with. Named once so an assertion about the reply cannot drift from
   * the fixture that produced it. */
  const SECTION_TEXT = "the stored passage the hit located.";

  /** A located hit in the shape doc-etl-api reports one, in a speakable
   * collection and carrying the section the search was asked to expand it to.
   *
   * The section's text is deliberately unlike the chunk's own `text` — the
   * search's quote of it — so a test can tell a reply taken from the section
   * from one built out of the hit itself. The range and the stated length agree,
   * which is what the gate reads as a whole section. */
  const located = (overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk => ({
    text: "the text the search quoted",
    source: "Trang Quynh",
    score: 0.71,
    address: "https://example.org/wiki/A",
    collections: ["truyen-kiem-hiep"],
    position: 3,
    section: {
      text: SECTION_TEXT,
      start: 1200,
      end: 1200 + SECTION_TEXT.length,
      size: SECTION_TEXT.length,
    },
    ...overrides,
  });

  /** How many times the route asked a model to answer: the streaming call and the
   * non-streaming fallback together. A material turn must produce zero. */
  const modelCalls = (h: Harness): number => h.prompts.length + h.nonStreaming.length;

  /** A material turn's request, over the scope the kiếm hiệp persona declares. */
  const MATERIAL_TURN = {
    text: "ke chuyen kiem hiep",
    enabledTopics: ["truyen-kiem-hiep"],
    answerMode: "material",
    history: LATER_TURN,
  };

  it("answers a material turn from the section the search returned, without asking a model", async () => {
    const h = harness({ ok: true, chunks: [located()] });

    await withServer(h.deps, async (api) => {
      const events = parseSse(await sendTurn(api.stream, h, MATERIAL_TURN));

      assert.equal(modelCalls(h), 0, "a material turn must not ask a model at all");
      assert.deepEqual(
        events.filter((event) => event.event === "sentence").map((event) => event.data.text),
        [SECTION_TEXT],
        "the reply is the section that came with the hit, and not the search's quote of it"
      );
      assert.equal(events.at(-1)?.event, "done");
      assert.equal(events.at(-1)?.data.fullText, SECTION_TEXT);
    });
  });

  it("emits no event type the client does not already handle", async () => {
    const h = harness({ ok: true, chunks: [located()] });

    await withServer(h.deps, async (api) => {
      const events = parseSse(await sendTurn(api.stream, h, MATERIAL_TURN));
      const names = new Set(events.map((event) => event.event));

      assert.ok(names.has("sentence"), `a material reply is spoken as sentences, got ${[...names]}`);
      assert.ok(names.has("done"), `a material turn closes like any other, got ${[...names]}`);
      assert.deepEqual(
        [...names].filter((name) => !["user", "text", "sentence", "done"].includes(name)),
        [],
        "the transcript builds a material reply from the same events a generated one uses"
      );
    });
  });

  it("asks the search for a single result on a material turn, and the full k on a generating one", async () => {
    const h = harness({ ok: true, chunks: [located()] });

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, MATERIAL_TURN);
      await sendTurn(api.stream, h, { ...MATERIAL_TURN, answerMode: "generate" });

      assert.equal(h.searches[0].topK, 1, "the locator asks for one result (D1)");
      assert.equal(
        h.searches[1].topK,
        DEFAULT_PREFETCH_TOP_K,
        "a generating turn's search is unchanged by this capability"
      );
    });
  });

  it("asks for the hit's section on a material turn, and asks for nothing extra on a generating one", async () => {
    const h = harness({ ok: true, chunks: [located()] });

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, MATERIAL_TURN);
      await sendTurn(api.stream, h, { ...MATERIAL_TURN, answerMode: "generate" });

      assert.deepEqual(
        h.searches[0].options,
        { expand: "section" },
        "the locator must ask for the passage the reply will be spoken from (D1)"
      );
      assert.equal(
        h.searches[1].options,
        undefined,
        "a generating turn's search asks for no section, so its request body is unchanged (D5)"
      );
    });
  });

  it("speaks nothing from the material on a persona that generates, however eligible its hit", async () => {
    const h = harness({ ok: true, chunks: [located()] }, { stream: ["A generated answer."] });

    await withServer(h.deps, async (api) => {
      const events = parseSse(await sendTurn(api.stream, h, { ...MATERIAL_TURN, answerMode: "generate" }));

      assert.ok(modelCalls(h) > 0, "a generating persona's turn is answered by the model");
      assert.equal(
        events.at(-1)?.data.fullText,
        "A generated answer.",
        "the reply is the model's, not the section the hit carried"
      );
      assert.ok(
        !h.logs.some((line) => line.includes("Material")),
        `the path must not be entered and abandoned, logged: ${h.logs.join(" | ")}`
      );
    });
  });

  it("generates when the hit's source is not speakable, without speaking it", async () => {
    const h = harness(
      { ok: true, chunks: [located({ collections: ["truyen-cuoi"] })] },
      { stream: ["A generated answer."] }
    );

    await withServer(h.deps, async (api) => {
      // The joke topic folds to a collection the corpus serves and this
      // deployment does not speak, so the hit is in scope for the search and
      // refused by the gate.
      await sendTurn(api.stream, h, { ...MATERIAL_TURN, enabledTopics: ["Truyện cười"] });

      assert.ok(modelCalls(h) > 0);
      assert.ok(h.logs.some((line) => line.includes("(not_speakable)")));
    });
  });

  it("generates when the hit is below the floor", async () => {
    const h = harness(
      { ok: true, chunks: [located({ score: 0.42 })] },
      { stream: ["A generated answer."] }
    );

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, MATERIAL_TURN);

      assert.ok(modelCalls(h) > 0);
      assert.ok(h.logs.some((line) => line.includes("(below_floor)")));
    });
  });

  it("generates when no enabled topic resolves to a collection, issuing no search at all", async () => {
    const h = harness({ ok: true, chunks: [located()] }, { stream: ["A generated answer."] });

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, { ...MATERIAL_TURN, enabledTopics: ["!!!"] });

      assert.deepEqual(h.searches, [], "a material turn with no scope has nothing to locate with");
      assert.ok(modelCalls(h) > 0);
      assert.ok(h.logs.some((line) => line.includes("(no_hit)")));
    });
  });

  it("generates when the search returned no section with the hit", async () => {
    // The older service, and any search that was not asked to expand: the hit is
    // eligible on every other count, and what it lacks is the passage to speak.
    const h = harness(
      { ok: true, chunks: [located({ section: undefined })] },
      { stream: ["A generated answer."] }
    );

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, MATERIAL_TURN);

      assert.ok(modelCalls(h) > 0);
      assert.ok(
        !h.logs.some((line) => line.includes("Material reply: read")),
        "nothing was spoken from the corpus"
      );
      assert.ok(h.logs.some((line) => line.includes("(no_section)")));
    });
  });

  it("generates when the section came back shorter than the service stated", async () => {
    const h = harness(
      {
        ok: true,
        chunks: [
          located({
            section: { text: "the passage's opening.", start: 1200, end: 1221, size: 4200 },
          }),
        ],
      },
      { stream: ["A generated answer."] }
    );

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, MATERIAL_TURN);

      assert.ok(modelCalls(h) > 0);
      assert.ok(h.logs.some((line) => line.includes("(section_incomplete)")));
    });
  });

  it("reuses a claimed prefetch as the locator instead of searching twice", async () => {
    const h = harness({ ok: true, chunks: [located()] });

    await withServer(h.deps, async (api) => {
      // Declared as a material turn's prefetch, which is what makes its hits carry
      // the section the turn will speak (D6).
      const prefetchId = await sendPrefetch(api.prefetch, h, {
        text: MATERIAL_TURN.text,
        enabledTopics: MATERIAL_TURN.enabledTopics,
        answerMode: "material",
      });
      assert.ok(prefetchId, "the prefetch must hold something to be reused");

      const events = parseSse(await sendTurn(api.stream, h, { ...MATERIAL_TURN, prefetchId }));

      assert.equal(
        h.searches.length,
        1,
        "the prefetch's search is the locator's; a material turn issues no second"
      );
      assert.equal(modelCalls(h), 0);
      assert.equal(events.at(-1)?.data.fullText, SECTION_TEXT);
      assert.ok(h.logs.some((line) => line.includes("Reused prefetched knowledge")));
    });
  });

  it("declines a held prefetch that carries no section, issuing its own locator search", async () => {
    // The prefetch as it is issued today, for the generating path: its hits carry
    // no section, so no material turn can be spoken from them, and reusing the
    // hold regardless would turn this turn into a generated one merely because a
    // prefetch happened to be held (design.md D6). The turn then does exactly what
    // it does with no prefetch held.
    let issued = 0;
    const h = harness(() =>
      ++issued === 1
        ? { ok: true, chunks: [located({ section: undefined })] }
        : { ok: true, chunks: [located()] }
    );

    await withServer(h.deps, async (api) => {
      const prefetchId = await sendPrefetch(api.prefetch, h, {
        text: MATERIAL_TURN.text,
        enabledTopics: MATERIAL_TURN.enabledTopics,
      });
      assert.ok(prefetchId, "the prefetch holds a hit — it is only unusable to a material turn");

      const events = parseSse(await sendTurn(api.stream, h, { ...MATERIAL_TURN, prefetchId }));

      assert.equal(h.searches.length, 2, "the held section-less hit, then the turn's own locator");
      assert.equal(h.searches[1].topK, 1, "the search the turn issues for itself is its locator");
      assert.deepEqual(
        h.searches[1].options,
        { expand: "section" },
        "and it asks for the section the reply will be spoken from"
      );
      assert.equal(modelCalls(h), 0, "the turn is still answered from the material");
      assert.equal(events.at(-1)?.data.fullText, SECTION_TEXT);
      assert.ok(
        h.logs.some((line) => line.includes("issuing the locator search instead")),
        `the decline must be logged, got: ${h.logs.join(" | ")}`
      );
    });
  });

  it("records the reply as the turn's message, so the next turn's history carries it", async () => {
    const h = harness({ ok: true, chunks: [located()] }, { stream: ["A generated answer."] });

    await withServer(h.deps, async (api) => {
      const read = parseSse(await sendTurn(api.stream, h, MATERIAL_TURN));
      const reply = read.at(-1)?.data.fullText;
      assert.equal(reply, SECTION_TEXT);

      // A material turn persists nothing a generated one does not: the reply
      // travels as `done.fullText`, the client holds it, and it comes back as the
      // next turn's `history` — which is the whole of "the session holds it as
      // that turn's assistant message".
      await sendTurn(api.stream, h, {
        text: "and then what happened?",
        enabledTopics: ["truyen-kiem-hiep"],
        answerMode: "generate",
        history: JSON.stringify([
          { role: "user", content: MATERIAL_TURN.text },
          { role: "agent", content: reply },
        ]),
      });

      const nextPrompt = h.prompts.at(-1) ?? "";
      assert.ok(
        nextPrompt.includes(SECTION_TEXT),
        `the turn after must receive the reply as history, got: ${nextPrompt}`
      );
    });
  });

  it("logs a material read and a fallback as distinct lines, naming the reason", async () => {
    // One harness, two turns: the first locates an eligible hit, the second one
    // under the floor — so both lines come from one run and are compared against
    // each other rather than against a literal.
    const h = harness(
      (call) =>
        call.query === "readable"
          ? { ok: true, chunks: [located()] }
          : { ok: true, chunks: [located({ score: 0.42 })] },
      { stream: ["A generated answer."] }
    );

    await withServer(h.deps, async (api) => {
      await sendTurn(api.stream, h, { ...MATERIAL_TURN, text: "readable" });
      await sendTurn(api.stream, h, { ...MATERIAL_TURN, text: "not readable" });

      const readLine = h.logs.find((line) => line.includes("Material reply: read"));
      const fallbackLine = h.logs.find((line) =>
        line.includes("Material path did not answer this turn")
      );

      assert.ok(readLine, `the read must be logged, got: ${h.logs.join(" | ")}`);
      assert.ok(fallbackLine, `the fallback must be logged, got: ${h.logs.join(" | ")}`);
      assert.notEqual(readLine, fallbackLine);
      assert.ok(
        fallbackLine.includes("below_floor"),
        `the fallback line must name the reason, got: ${fallbackLine}`
      );
      assert.ok(
        readLine.includes(located().source),
        `the read line must name the source it spoke, got: ${readLine}`
      );
    });
  });
});

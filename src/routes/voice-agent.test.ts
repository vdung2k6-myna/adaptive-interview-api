import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { createVoiceAgentRouter, type VoiceAgentDeps } from "./voice-agent";
import type { KnowledgeChunk, KnowledgeSearchOutcome } from "../lib/knowledge";
import { SentenceExtractor } from "../lib/audio/sentence-extractor";

interface SearchCall {
  query: string;
  topK?: number;
  collections?: string[];
}

interface Harness {
  deps: Partial<VoiceAgentDeps>;
  /** Every search the route issued, in order. */
  searches: SearchCall[];
  /** Every message array the route gave the LLM, flattened to text. */
  prompts: string[];
  /** Everything the route logged, so a test can assert on a drop or a query. */
  logs: string[];
  /** What the route did, in order — `"search"` and `"transcribe"` — so a test
   * can assert that the session's speculative search is issued before the turn
   * awaits transcription rather than merely issued (4.1). */
  events: string[];
  /** The text of every chunk the route asked to synthesize, in order — what the
   * turn actually spoke, which is not the same claim as what it emitted. */
  synthCalls: string[];
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
  } = {}
): Harness {
  const searches: SearchCall[] = [];
  const prompts: string[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const synthCalls: string[] = [];
  const tokens = settings.stream ?? [];
  const fullText = settings.fullText ?? tokens.join("");

  return {
    searches,
    prompts,
    logs,
    events,
    synthCalls,
    deps: {
      searchKnowledge: async (query, topK, collections) => {
        const call = { query, topK, collections };
        searches.push(call);
        events.push("search");
        if (settings.neverSettles?.(call)) {
          return new Promise<KnowledgeSearchOutcome>(() => {});
        }
        return await (typeof reply === "function" ? reply(call) : reply);
      },
      transcribeAudio: async () => {
        events.push("transcribe");
        return { text: "transcribed words", confidence: 0.9 };
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
      generateChatResponse: async () => "",
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
  form.append("language", "english");
  form.append("audio", new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/wav" }), "turn.wav");
  for (const [key, value] of Object.entries(body)) {
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

/**
 * 6.3's measurement. Runs against the API instance on :4100 (the change's code)
 * and the live doc-etl-api on :8000. Not a repo artifact — the numbers it
 * produces are recorded in tasks.md 6.3.
 *
 * Models a text turn the way the client now drives it: the user stops typing at
 * t0, the client debounces, issues the prefetch, and submits at t0 + pause. The
 * id is carried only if the prefetch had settled by the submit moment, which is
 * exactly the client's rule.
 */
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:4100";
const TEXT = "kiem hiep la gi";
const TOPICS = ["Truyện kiếm hiệp"];
const DEBOUNCE = 250;
const TOKEN = readFileSync("D:/Working/Projects/adaptive-interview-api/.env", "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("API_AUTH_TOKEN="))
  .slice("API_AUTH_TOKEN=".length)
  .trim();

const AUTH = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x);

async function prefetch(text) {
  const started = now();
  const res = await fetch(`${BASE}/api/voice-agent/prefetch`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ text, enabledTopics: TOPICS }),
  });
  const body = await res.json();
  return { ms: now() - started, id: body.prefetchId ?? null };
}

/** Submit a turn, returning time to the first SSE event and to `done`. */
async function turn(text, prefetchId, extra = {}) {
  const started = now();
  const res = await fetch(`${BASE}/api/voice-agent/stream`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      systemPrompt: "You are a tutor. Answer briefly.",
      language: "english",
      text,
      enabledTopics: TOPICS,
      ...(prefetchId ? { prefetchId } : {}),
      ...extra,
    }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstEvent = null;
  let firstToken = null;
  let done = null;
  let buffer = "";
  let sawError = null;

  while (true) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      if (!block.trim()) continue;
      const event = /event: (.*)/.exec(block)?.[1];
      if (firstEvent === null) firstEvent = now() - started;
      if (event === "text" && firstToken === null) firstToken = now() - started;
      if (event === "error") sawError = block.replace(/\n/g, " ").slice(0, 120);
      if (event === "done") done = now() - started;
    }
  }
  return { firstEvent, firstToken, done, sawError };
}

/**
 * Hold doc-etl-api's single search lock, so the turn's own search pays the queue.
 * The service is not modified — it is made busy, which is what contention is.
 */
async function holdSearchLock(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  const search = fetch("http://127.0.0.1:8000/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "lock holder", top_k: 1, collections: TOPICS.map(() => "truyen-kiem-hiep") }),
    signal: controller.signal,
  }).catch(() => null);
  await sleep(20); // let it reach the lock
  return search;
}

const results = { prefetch: [], sweep: [], turns: {} };

/** A-D are the prefetch's value and are recorded in tasks.md; `--ef` runs only
 * the sections 6.3's second half needs, so they are not re-measured needlessly. */
const ONLY_EF = process.argv.includes("--ef");

sectionsAD: {
if (ONLY_EF) break sectionsAD;

console.log("== A. prefetch latency (debounce excluded), 5 samples ==");
for (let i = 0; i < 5; i++) {
  const { ms, id } = await prefetch(TEXT);
  results.prefetch.push(ms);
  console.log(`  ${round(ms)} ms  id=${id ? "held" : "null"}`);
  await sleep(120);
}
console.log(`  median ${round(median(results.prefetch))} ms\n`);

console.log("== B. did the prefetch complete before the submit? ==");
for (const pause of [0, 200, 300, 400, 500, 800]) {
  const settled = [];
  let carried = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = now();
    let settledAt = null;
    let id = null;
    const issuing = (async () => {
      await sleep(DEBOUNCE);
      const r = await prefetch(TEXT);
      settledAt = now() - t0;
      id = r.id;
    })();

    await sleep(pause);
    const carriedId = settledAt !== null ? id : null;
    if (carriedId) carried++;
    const t = await turn(TEXT, carriedId);
    await issuing;
    settled.push(settledAt === null ? null : round(settledAt));
    if (t.sawError) console.log(`  (turn error: ${t.sawError})`);
    await sleep(300);
  }
  results.sweep.push({ pause, carried, settled });
  console.log(
    `  submit at +${String(pause).padStart(4)} ms: prefetch had settled ${carried}/3` +
      `  (settled at t0+${settled.map((s) => s ?? "—").join(", ")} ms)`
  );
}

console.log("\n== C. turn latency: reuse vs fresh vs fresh-under-contention ==");
async function turnCase(label, { prefetchFirst = false, contend = false } = {}) {
  const times = { firstToken: [], done: [] };
  for (let i = 0; i < 3; i++) {
    const release = contend ? await holdSearchLock(3000) : null;
    // A fresh prefetch per iteration: a hold is single-use, so reusing one id
    // would silently measure the miss path on the second and third turns.
    const { id } = prefetchFirst ? await prefetch(TEXT) : { id: null };
    const t = await turn(TEXT, id);
    if (release) await Promise.race([release, sleep(1500)]);
    if (t.firstToken !== null) times.firstToken.push(round(t.firstToken));
    if (t.done !== null) times.done.push(round(t.done));
    if (t.sawError) console.log(`  ${label}: error ${t.sawError}`);
    await sleep(500);
  }
  results.turns[label] = times;
  console.log(
    `  ${label.padEnd(26)} first text event ${times.firstToken.join("/")} ms   done ${times.done.join("/")} ms`
  );
}

await turnCase("reuse (matching prefetch)", { prefetchFirst: true });
await turnCase("miss (fresh search)");
await turnCase("miss under contention", { contend: true });

console.log("\n== D. one reused turn vs one fresh turn, same session ==");
for (const label of ["reuse", "fresh"]) {
  const { id } = label === "reuse" ? await prefetch(TEXT) : { id: null };
  const t = await turn(TEXT, id);
  console.log(`  ${label}: first text event ${round(t.firstToken)} ms, done ${round(t.done)} ms`);
}
}

/**
 * A session's *first* topical turn issues the session's topic-scoped search and
 * then its own, back to back — a text turn has no transcription to wait for, so
 * the two overlap by construction. That is the worst case for doc-etl-api's one
 * lock, and it is what 6.3's second half asks about: does the speculative search
 * (D4) contend with the turn's own?
 */
const LATER = JSON.stringify([
  { role: "user", content: "an earlier question" },
  { role: "agent", content: "an earlier answer" },
]);

console.log("\n== E. the session's topic-scoped search vs the turn's own ==");
async function sessionCase(label, { first, contend }) {
  const times = [];
  const dones = [];
  for (let i = 0; i < 3; i++) {
    const release = contend ? await holdSearchLock(3000) : null;
    const t = await turn(TEXT, null, first ? {} : { history: LATER });
    if (release) await Promise.race([release, sleep(1500)]);
    if (t.firstToken !== null) times.push(round(t.firstToken));
    if (t.done !== null) dones.push(round(t.done));
    if (t.sawError) console.log(`  ${label}: error ${t.sawError}`);
    await sleep(500);
  }
  console.log(
    `  ${label.padEnd(36)} first text event ${times.join("/")} ms   done ${dones.join("/")} ms`
  );
}

await sessionCase("first turn (session search + own)", { first: true });
await sessionCase("later turn (own search only)", { first: false });
await sessionCase("first turn, lock held", { first: true, contend: true });
await sessionCase("later turn, lock held", { first: false, contend: true });

/**
 * On a *voice* turn the session's search is issued before the route awaits
 * transcription, so if transcription outlasts the search the lock is free again
 * before the turn's own search is issued and the two cannot contend at all.
 * Measure the transcription leg with synthetic audio; if the STT service returns
 * no text for it, say so rather than reporting a latency that was not measured.
 */
function wav(ms, { tone = false, sampleRate = 16000 } = {}) {
  const samples = Math.floor((ms / 1000) * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const v = tone ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)) : 0;
    buffer.writeInt16LE(v, 44 + i * 2);
  }
  return buffer;
}

console.log("\n== F. voice turn: is the speculative search done before the turn's own? ==");
async function voiceTurn(label, audio) {
  const started = now();
  const form = new FormData();
  form.append("systemPrompt", "You are a tutor. Answer briefly.");
  form.append("language", "english");
  form.append("enabledTopics", JSON.stringify(TOPICS));
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "turn.wav");

  const res = await fetch(`${BASE}/api/voice-agent/stream`, { method: "POST", headers: { Authorization: AUTH.Authorization }, body: form });
  const text = await res.text();
  const blocks = text.split("\n\n").filter((b) => b.trim());
  const at = (name) => {
    let seen = "";
    for (const block of blocks) {
      seen += block;
      if (new RegExp(`event: ${name}`).test(block)) return round(now() - started);
    }
    return null;
  };
  console.log(
    `  ${label.padEnd(10)} status ${res.status}  user event ${at("user") ?? "—"} ms  ` +
      `done ${at("done") ?? "—"} ms  events: ${blocks.map((b) => /event: (.*)/.exec(b)?.[1]).join(",")}`
  );
}

await voiceTurn("silence", wav(1200));
await voiceTurn("tone", wav(1200, { tone: true }));

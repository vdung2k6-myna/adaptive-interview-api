import type { AppConfig } from "./index";
import { parseList, parsePositiveInt, parseUnitInterval } from "./env";
import { parseProviderCatalog, parseProviderDefaults } from "@/lib/providers";

// Read once, so the defaults are checked against the catalog they actually
// belong to rather than against a second parse that could disagree.
const providerCatalog = parseProviderCatalog(process.env.PROVIDER_CATALOG, "PROVIDER_CATALOG");

export const developmentConfig: AppConfig = {
  env: "development",
  database: {
    poolSize: 5,
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    chatModel: process.env.OLLAMA_MODEL || "llama3.1",
    embedModel: process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large",
    chatTimeoutMs: 120_000, // 120s — kimi-k2.6:cloud needs more time for long context
    embedTimeoutMs: 15_000, // 15s
    retries: parsePositiveInt(process.env.OLLAMA_RETRIES, 1),
    retryDeadlineMs: parsePositiveInt(process.env.OLLAMA_RETRY_DEADLINE_MS, 20_000),
    retryAfterMaxMs: parsePositiveInt(process.env.OLLAMA_RETRY_AFTER_MAX_MS, 60_000),
    // Twelve, below the fifteen the cloud account was measured to accept
    // (`docs/CAPACITY.md`). Staying under it is the point: a turn queues here,
    // where it can be ordered, instead of being refused upstream.
    maxConcurrentRequests: parsePositiveInt(process.env.OLLAMA_MAX_CONCURRENT_REQUESTS, 12),
  },
  transcriptBuffer: {
    // Fifteen minutes: the transport accepts about five and a half of speech, so
    // this is the answer plus the pause after it, and an abandoned turn is
    // reclaimed well before a process restart would do it.
    retentionMs: parsePositiveInt(process.env.TRANSCRIPT_BUFFER_RETENTION_MS, 15 * 60_000),
  },
  evaluation: {
    temperature: 0.3,
    maxAttempts: 3,
  },
  features: {
    enableStreaming: true,
    enableEvaluations: true,
    enableEmbeddings: true,
  },
  mcp: {
    enabled: process.env.MCP_ENABLED === "true",
    authToken: process.env.MCP_AUTH_TOKEN || "",
  },
  auth: {
    apiToken: process.env.API_AUTH_TOKEN || "",
  },
  audio: {
    // Unset means the deployment runs no such service — never localhost by
    // default, so a deployment that removes its audio tier reads as one without
    // it rather than one that keeps failing to reach an address nobody chose.
    sttUrl: (process.env.AUDIOCPP_BASE_URL ?? "").trim(),
    gatewayUrl: (process.env.AUDIO_GATEWAY_URL ?? "").trim(),
    sttModel: process.env.AUDIOCPP_STT_MODEL || "stt",
    defaultEngine: (process.env.DEFAULT_TTS_ENGINE as "kokoro" | "piper" | "supertonic" | undefined) || undefined,
    defaultVoice: process.env.DEFAULT_VOICE || "bryce",
    timeoutMs: 60_000,
    // Four: enough that a reply's segments are spoken as they are produced, few
    // enough that one long reply cannot occupy the gateway. The gateway was
    // measured at 23x real-time and serializing (`docs/CAPACITY.md`).
    synthesisConcurrency: parsePositiveInt(process.env.AUDIO_SYNTHESIS_CONCURRENCY, 4),
    // 10 minutes — the generous end of "a few minutes". Disk here is one
    // developer's, and the case a tight window would break is exactly the one
    // that happens on a dev machine: a tab left open across a restart, still
    // holding segment URLs from the turn it was in the middle of.
    segmentRetentionMs: parsePositiveInt(process.env.AUDIO_SEGMENT_RETENTION_MS, 10 * 60_000),
    voices: {
      kokoro: {
        english: process.env.KOKORO_VOICE_ENGLISH || "af_heart",
        vietnamese: process.env.KOKORO_VOICE_VIETNAMESE || "",
      },
      piper: {
        english: process.env.PIPER_VOICE_ENGLISH || "bryce",
        vietnamese: process.env.PIPER_VOICE_VIETNAMESE || "",
      },
      supertonic: {
        english: process.env.SUPERTONIC_VOICE_ENGLISH || "F1",
        vietnamese: process.env.SUPERTONIC_VOICE_VIETNAMESE || "F1",
      },
    },
  },
  providers: {
    catalog: providerCatalog,
    defaults: parseProviderDefaults(process.env, providerCatalog),
  },
  docEtl: {
    apiUrl: process.env.DOC_ETL_API_URL || "http://localhost:8005",
    // doc-etl-api preloads its embedding model, so a search is a query embedding
    // plus an in-memory scan (~50-200ms). Retrieval is awaited before prompt
    // construction, so an over-long timeout costs first-token latency on every
    // turn while the service is down.
    searchTimeoutMs: parsePositiveInt(process.env.DOC_ETL_SEARCH_TIMEOUT_MS, 1_500),
  },
  material: {
    // The wiki collections, whose stored text is clean enough to be spoken as it
    // is stored. `truyen-cuoi` is deliberately absent: its stored text is
    // OCR-corrupted, so a joke read aloud verbatim would be read as gibberish,
    // and that is a fact about the file rather than about any persona (D3).
    //
    // The two names tag the same ten sources today and are listed separately
    // because nothing holds them together — which one a source carries depends
    // on how it was ingested, and a corpus that adds one without the other
    // should not have to be re-derived here.
    collections: parseList(process.env.MATERIAL_COLLECTIONS, [
      "truyen-kiem-hiep",
      "kiem-hiep",
    ]),
    // Measured on the development corpus with `node scripts/measure-material-floor.mjs`
    // (23 Sep 2026), which sends the same request a material turn's locator sends —
    // `top_k: 1`, scoped to the speakable set — for 24 queries:
    //
    //   on-topic, one of the ten sources named     8 queries   0.635 – 0.677
    //   on-topic but vaguely asked                 8 queries   0.480 – 0.596
    //   plainly off-topic                          8 queries   0.380 – 0.531
    //
    // The top band and the bottom one do not overlap, so any floor in
    // (0.531, 0.635] separates "asked about a named story" from "asked about
    // something else". 0.55 sits in the lower half of that interval and refuses
    // none of the eight named queries, 3 of the 8 vague ones, and none of the 8
    // off-topic ones — the vague band is where the cost of erring high shows up,
    // and vague-but-in-scope is the case where generating is the right answer
    // anyway. Re-measure with the same script after any corpus or embedding-model
    // change; one model over one corpus is evidence for a default, not a
    // constant, which is why this is config (7.1).
    //
    // It errs high because the two ways to be wrong are not symmetric: too low
    // speaks an off-topic passage verbatim, which is audible in the first second
    // of audio, while too high generates, which is what every turn does today
    // and is invisible (D4).
    scoreFloor: parseUnitInterval(process.env.MATERIAL_SCORE_FLOOR, 0.55),
  },
  music: {
    // Empty, and unset is empty: music is something a deployment opts into, and a shipped default
    // would point every deployment at a directory that is not there. It has to be inside
    // `AUDIO_STORAGE_DIR` for its tracks to have a URL — see `AppConfig.music`.
    //
    // The files are the deployment's own. What may be played is theirs to answer for, and this
    // repository ships no music and grants no rights to any — and holding a track is not playing it:
    // a track played to a person during an interview reaches someone other than the operator, which
    // is a right distinct from keeping the file. See `NOTICE`.
    libraryDir: (process.env.MUSIC_LIBRARY_DIR || "").trim(),
  },
  toolCalls: {
    // 8s. A gadget answers in milliseconds when it answers at all, so this is spent by a person
    // listening to silence — and it is well under `ollama.chatTimeoutMs`, which bounds the two
    // model rounds the wait sits between.
    timeoutMs: parsePositiveInt(process.env.TOOL_CALL_TIMEOUT_MS, 8_000),
    // See `AppConfig.toolCalls.maxRounds` for why three: one request for a track is answered in two
    // rounds — the shelf, and the number on it — where two was set for a person asking for two things
    // in one breath.
    maxRounds: parsePositiveInt(process.env.TOOL_CALL_MAX_ROUNDS, 3),
  },
};

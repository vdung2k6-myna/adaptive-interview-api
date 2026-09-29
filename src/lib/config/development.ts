import type { AppConfig } from "./index";
import { parseList, parsePositiveInt, parseUnitInterval } from "./env";

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
    retries: 1,
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
    sttUrl: process.env.AUDIOCPP_BASE_URL || "http://localhost:8080",
    gatewayUrl: process.env.AUDIO_GATEWAY_URL || "http://localhost:8082",
    sttModel: process.env.AUDIOCPP_STT_MODEL || "stt",
    defaultEngine: (process.env.DEFAULT_TTS_ENGINE as "kokoro" | "piper" | "supertonic") || "supertonic",
    defaultVoice: process.env.DEFAULT_VOICE || "default_name",
    timeoutMs: 60_000,
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
        english: process.env.PIPER_VOICE_ENGLISH || "en_US-lessac-medium",
        vietnamese: process.env.PIPER_VOICE_VIETNAMESE || "",
      },
      supertonic: {
        english: process.env.SUPERTONIC_VOICE_ENGLISH || "F1",
        vietnamese: process.env.SUPERTONIC_VOICE_VIETNAMESE || "F1",
      },
    },
  },
  docEtl: {
    apiUrl: process.env.DOC_ETL_API_URL || "http://localhost:8000",
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
};

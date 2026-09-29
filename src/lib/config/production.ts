import type { AppConfig } from "./index";
import { parseList, parsePositiveInt, parseUnitInterval } from "./env";

export const productionConfig: AppConfig = {
  env: "production",
  database: {
    poolSize: 20, // Higher concurrency in production
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    chatModel: process.env.OLLAMA_MODEL || "llama3.1",
    embedModel: process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large",
    chatTimeoutMs: 120_000, // 120s — remote/cloud models may need more time
    embedTimeoutMs: 30_000, // 30s
    retries: 2,
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
    // 5 minutes — half development's, because what multiplies here is disk:
    // window times turns in flight. Still two orders of magnitude more than a
    // segment needs to survive being fetched, and a window set too short fails
    // toward unavailable audio, which the client's canonical-audio recovery
    // covers.
    segmentRetentionMs: parsePositiveInt(process.env.AUDIO_SEGMENT_RETENTION_MS, 5 * 60_000),
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
    // See development.ts — keep this tight; it is paid on every turn while the
    // service is unreachable.
    searchTimeoutMs: parsePositiveInt(process.env.DOC_ETL_SEARCH_TIMEOUT_MS, 1_500),
  },
  material: {
    // Empty until a deployment says otherwise, which is what makes the material
    // path safe to ship: with no speakable collection, every turn generates
    // exactly as it does today, so a deployment that has never measured its own
    // corpus cannot begin speaking stored passages by inheriting a default (D5).
    //
    // Setting this to a blank value is the same decision said explicitly, and
    // `parseList` honours it as such.
    collections: parseList(process.env.MATERIAL_COLLECTIONS, []),
    // See development.ts for the measurement. Unread while the speakable set is
    // empty, and defaulted here so that turning a collection on does not also
    // require choosing a floor in the same change.
    scoreFloor: parseUnitInterval(process.env.MATERIAL_SCORE_FLOOR, 0.55),
  },
};

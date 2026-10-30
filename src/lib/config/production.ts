import type { AppConfig } from "./index";
import { parseList, parsePositiveInt, parseUnitInterval } from "./env";
import { parseProviderCatalog, parseProviderDefaults } from "@/lib/providers";

// Read once, so the defaults are checked against the catalog they actually
// belong to rather than against a second parse that could disagree.
const providerCatalog = parseProviderCatalog(process.env.PROVIDER_CATALOG, "PROVIDER_CATALOG");

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
    retries: parsePositiveInt(process.env.OLLAMA_RETRIES, 2),
    retryDeadlineMs: parsePositiveInt(process.env.OLLAMA_RETRY_DEADLINE_MS, 30_000),
    retryAfterMaxMs: parsePositiveInt(process.env.OLLAMA_RETRY_AFTER_MAX_MS, 60_000),
    // Twelve, below the fifteen the cloud account was measured to accept
    // (`docs/CAPACITY.md`). Staying under it is the point: a turn queues here,
    // where it can be ordered, instead of being refused upstream.
    maxConcurrentRequests: parsePositiveInt(process.env.OLLAMA_MAX_CONCURRENT_REQUESTS, 12),
  },
  transcriptBuffer: {
    // Fifteen minutes, for the same reason as development: the transport accepts
    // about five and a half minutes of speech, and an abandoned turn must not be
    // held for longer than it could plausibly still be submitted.
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
  music: {
    // Same as development, and deliberately not a second opinion: whether this deployment has a
    // music library is a fact about the deployment, not about which environment it runs in. See
    // development.ts, and `AppConfig.music` for the two things it must be.
    libraryDir: (process.env.MUSIC_LIBRARY_DIR || "").trim(),
  },
  toolCalls: {
    // Same as development, and deliberately not a second opinion: the wait is spent by a person
    // listening to silence, which a deployment does not make shorter. See development.ts.
    timeoutMs: parsePositiveInt(process.env.TOOL_CALL_TIMEOUT_MS, 8_000),
    maxRounds: parsePositiveInt(process.env.TOOL_CALL_MAX_ROUNDS, 3),
  },
};

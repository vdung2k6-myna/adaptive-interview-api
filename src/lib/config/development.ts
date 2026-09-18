import type { AppConfig } from "./index";

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
  },
};

export interface AppConfig {
  env: "development" | "production" | "test";
  database: {
    poolSize: number;
  };
  ollama: {
    baseUrl: string;
    chatModel: string;
    embedModel: string;
    chatTimeoutMs: number;
    embedTimeoutMs: number;
    retries: number;
  };
  evaluation: {
    temperature: number;
    maxAttempts: number;
  };
  features: {
    enableStreaming: boolean;
    enableEvaluations: boolean;
    enableEmbeddings: boolean;
  };
  mcp: {
    enabled: boolean;
    authToken: string;
  };
  auth: {
    apiToken: string; // API_AUTH_TOKEN — if empty, auth is disabled
  };
  audio: {
    sttUrl: string;        // audio.cpp server (STT)
    gatewayUrl: string;      // Audio Gateway (TTS)
    sttModel: string;
    defaultEngine: "kokoro" | "piper" | "supertonic"; // default TTS engine
    defaultVoice: string;   // voice ID, e.g. "F1" (supertonic) or "af_heart" (kokoro)
    timeoutMs: number;
    /**
     * How long a streamed turn's per-segment files stay on disk after they are
     * written. It only has to outlast a client's fetch of a segment it has just
     * been told about — seconds — so the value is margin against a slow fetch,
     * not a playback budget. Deleting segments the moment their turn ended is
     * what made an announced segment unretrievable; see D2 of
     * `keep-turn-audio-playable`.
     */
    segmentRetentionMs: number;
    voices: {
      kokoro: {
        english: string;
        vietnamese: string;
      };
      piper: {
        english: string;
        vietnamese: string;
      };
      supertonic: {
        english: string;
        vietnamese: string;
      };
    };
  };
  docEtl: {
    apiUrl: string;          // Document ETL service URL for knowledge retrieval
    searchTimeoutMs: number; // per-request timeout for POST /search
  };
  /**
   * The material reply policy: which stored collections may be spoken verbatim,
   * and how confident a hit must be before one is.
   *
   * A policy rather than a service setting, which is why it is not part of
   * `docEtl`: the set describes the corpus, and the floor is a judgement about
   * it that was measured on one corpus with one embedding model. Both are read
   * per turn, so both are cheap to change without a deploy of code.
   */
  material: {
    /**
     * The collections whose stored text may be spoken as it is stored. A hit
     * whose source belongs to none of these cannot be a material reply, however
     * confident the hit is.
     */
    collections: string[];
    /**
     * The score a hit must reach to be spoken. Biased high on purpose — see the
     * measurement on this value in development.ts.
     */
    scoreFloor: number;
  };
}

import { developmentConfig } from "./development";
import { productionConfig } from "./production";

const env = (process.env.NODE_ENV as AppConfig["env"]) || "development";

const configs: Record<AppConfig["env"], AppConfig> = {
  development: developmentConfig,
  production: productionConfig,
  test: { ...developmentConfig, env: "test", database: { poolSize: 2 } },
};

const config: AppConfig = configs[env] ?? developmentConfig;

export default config;

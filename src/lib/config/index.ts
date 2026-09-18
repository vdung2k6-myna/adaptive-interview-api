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
    defaultVoice: string;   // voice ID, e.g. "default_name" (kokoro) or "vi_VN-vais1000-medium" (piper)
    timeoutMs: number;
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
    apiUrl: string; // Document ETL service URL for knowledge retrieval
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

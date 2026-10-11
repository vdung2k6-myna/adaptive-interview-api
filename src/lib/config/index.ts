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
    /**
     * A linear volume multiplier per engine, applied to the PCM the gateway
     * returns; 1 leaves it as the engine produced it.
     *
     * Per engine rather than one number because the engines do not agree on
     * loudness: measured on the same Vietnamese sentence, kokoro and piper come
     * back at full scale (0 dBFS peak) while supertonic sits ~8 dB below it
     * (`scripts/measure-engine-levels.mjs`). One shared level would be a
     * compromise between them; this is the knob that makes them match.
     */
    volume: {
      kokoro: number;
      piper: number;
      supertonic: number;
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
  /**
   * What a turn may ask a gadget to do, and how long it waits to hear that it was done.
   *
   * Both are bounds rather than preferences. The wait keeps a turn that asked for something
   * from hanging on an answer that is not coming; the round limit keeps a model that keeps
   * asking from turning one turn into a conversation with itself. See `lib/tool-calls.ts`
   * for how a turn is held, and `voice-agent.ts` for the loop these bound.
   */
  toolCalls: {
    /** How long a turn holds itself open for the bridge to report what a tool did. A gadget
     *  that answers at all answers in milliseconds; this is spent by a person listening to
     *  silence, so it is a bound on patience rather than on the network. */
    timeoutMs: number;
    /** The most tool calls one turn may make before it answers with whatever it has. A person
     *  can reasonably ask for two things in one breath; a model that asks for more than this
     *  is one no answer will satisfy. */
    maxRounds: number;
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

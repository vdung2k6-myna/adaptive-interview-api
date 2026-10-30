import type { ProviderKind, ProviderProfile } from "@/lib/providers";

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
    /**
     * How many further attempts a request refused before any content streamed
     * is given. A refusal there is the service saying it is at its concurrency
     * limit, not that the request was wrong, so the turn waits rather than
     * failing. A failure after content has started is never retried: the reply
     * would be spoken twice.
     */
    retries: number;
    /**
     * The whole retry budget, attempts included. Bounded separately from the
     * attempt count because backoff spends time, not attempts, and a turn that
     * has waited longer than this is worse than one that reports it could not
     * be answered.
     */
    retryDeadlineMs: number;
    /**
     * The longest a provider's own `Retry-After` may be honoured. A provider
     * that names a wait longer than this is reported rather than waited on: a
     * request that is itself over the provider's ceiling cannot be helped by
     * waiting, and a turn that sits for minutes is worse than one that says why.
     * This bound is separate from `retryDeadlineMs`, which budgets the runtime's
     * own backoff.
     */
    retryAfterMaxMs: number;
    /**
     * How many model requests this process may have in flight at once.
     *
     * Below the service's own ceiling on purpose: a refusal that is avoided is a
     * turn that never has to wait for a retry. It counts every caller — turns,
     * the agent's tool rounds, embedding — because they share one account.
     */
    maxConcurrentRequests: number;
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
    /** Empty when the deployment names no transcription service. */
    sttUrl: string;
    /** Empty when the deployment names no synthesis gateway. */
    gatewayUrl: string;
    sttModel: string;
    /**
     * The engine the legacy path speaks through, or undefined when the deployment
     * names none. No turn reaches a localhost address on its behalf.
     */
    defaultEngine?: "kokoro" | "piper" | "supertonic";
    defaultVoice: string;   // voice ID, e.g. "F1" (supertonic) or "af_heart" (kokoro)
    timeoutMs: number;
    /**
     * How many syntheses one turn may have in flight at once.
     *
     * A reply hands over every segment it has at a sentence boundary, and the
     * gateway serves them one at a time; without this bound a long reply
     * occupies the gateway with its own backlog and every other turn waits
     * behind it.
     */
    synthesisConcurrency: number;
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
  /**
   * The provider profiles this deployment publishes to its browser surface, and
   * which one answers a turn that names none of a kind.
   *
   * Operator configuration, not a table: the browser only chooses from what the
   * operator wrote, so no account owns a row and no key reaches a browser. The
   * catalog is read at boot; an entry that is malformed refuses the deployment
   * rather than the turn that would have named it.
   */
  providers: {
    catalog: ProviderProfile[];
    /** A profile id per kind, or null for "this deployment names no default". */
    defaults: Record<ProviderKind, string | null>;
  };
  /**
   * How long a turn's windows are held before the turn has to claim them.
   *
   * The buffer holds what has been transcribed and the audio those windows
   * carried; a turn that is never submitted — a person who stops and walks away —
   * would otherwise leave both until the process exits. Long enough to outlast the
   * longest answer the transport accepts, short enough that an abandoned turn is
   * not held for a day.
   */
  transcriptBuffer: {
    retentionMs: number;
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
   * The tracks this deployment can be asked to play, and nothing else about them.
   *
   * Empty is the absent case and not a degraded one: with no directory the platform offers the
   * model no music tool and sends no track, so a turn is asked exactly as it was before this
   * existed. A shipped non-empty default would point every deployment at a directory that exists
   * on none of them.
   *
   * The tracks are served by the audio mount, which wears the API's credential — so the directory
   * has to be **inside the audio root**, and one configured anywhere else has no URL at all. That
   * is reported at boot and the library is not offered, rather than taking the platform down over a
   * music directory: a service whose subject is interviews still has interviews to serve.
   *
   * The files are the deployment's own. What may be played is theirs to answer for, and this
   * service ships no music and grants no rights to any — and holding a track is not playing it: a
   * track played to a person during an interview reaches someone other than the operator, which is a
   * right distinct from keeping the file. See `NOTICE`.
   */
  music: {
    /** The directory the tracks are in, or empty for a deployment with no music. */
    libraryDir: string;
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
    /** How many rounds a turn may ask the model *with tools* before it is asked to answer in words.
     *
     *  A round and not a call: a model may name several things in one message, and a round is asked
     *  once whatever it asks for. Three, because a request for a track is answered in two rounds —
     *  the shelf, and then the number on it — and a model that spends one of them asking for a track
     *  it has no shelf for would otherwise have nothing left to answer with. A person can reasonably
     *  ask for two things in one breath; a model that asks for more than this is one no answer will
     *  satisfy. */
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

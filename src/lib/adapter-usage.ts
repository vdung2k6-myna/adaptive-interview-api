/**
 * What the runtime observed for one adapter call.
 *
 * It carries identifiers, sizes and counts — never the request text or audio —
 * so it can travel through the bridge and be recorded against the tenant. The
 * adapter's own reported usage, where an adapter reports one, is advisory; these
 * are the platform's observations.
 */

export type AdapterCallStatus =
  | "ok"
  | "upstream"
  | "timeout"
  | "rate_limit"
  | "refused"
  | "error";

export interface AdapterCallEvent {
  kind: "llm" | "stt" | "tts";
  /** Null for platform speech: a direct profile or the platform's fallback. */
  adapterId: string | null;
  status: AdapterCallStatus;
  latencyMs: number;
  bytes?: number;
  /** The audio the platform observed, for an STT or TTS call. */
  audioSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type AdapterCallListener = (call: AdapterCallEvent) => void;

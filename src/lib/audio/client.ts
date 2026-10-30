/**
 * HTTP clients for audio services.
 *
 * audio.cpp → STT (speech-to-text)
 * Audio Gateway → TTS (text-to-speech) via Kokoro or Piper
 *
 * The gateway exposes a single unified endpoint that routes to
 * the selected engine internally.
 */

import { openAsBlob } from "node:fs";
import config from "@/lib/config";

export interface TranscriptionResult {
  text: string;
  confidence?: number;
}

export interface SynthesizeOptions {
  /**
   * The engine the deployment's own gateway should route to, when the turn
   * names no provider profile. A profile names its engine in `model` instead.
   */
  engine?: "kokoro" | "piper" | "supertonic";
  /** The profile's endpoint. Absent means the deployment's gateway. */
  baseUrl?: string;
  /** The profile's key, when it has one. Never logged. */
  apiKey?: string;
  /**
   * The model the provider synthesizes with. The OpenAI contract names the
   * engine here, so the deployment gateway receives its engine as `model`.
   */
  model?: string;
  voice: string;
  signal?: AbortSignal;
}

/**
 * Where a provider profile lives, when a turn names one.
 *
 * Absent fields mean the deployment's own service: the audio.cpp URL and no
 * key. A profile supplies its own endpoint, and a key only when it has one.
 */
export interface ProviderTarget {
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Client for audio.cpp STT service.
 */
export class AudioCppClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = config.audio.sttUrl.replace(/\/$/, "");
    this.timeoutMs = config.audio.timeoutMs;
  }

  /**
   * Check if the audio.cpp server is reachable.
   */
  async healthCheck(): Promise<boolean> {
    // No address is a deployment without a transcription service, not a fault
    // to report: there is nothing to check.
    if (this.baseUrl === "") return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Speech-to-text: send an audio file and receive transcription.
   * @param audioPath Absolute path to the audio file on disk.
   * @param model Optional model override.
   * @param language Optional ISO-639-1 code to decode in. Without one the service
   * detects the language itself, and on a short, quiet, or weakly-onset
   * Vietnamese utterance it detects wrong — the caller hands the LLM a sentence
   * in a language nobody spoke. A caller that knows the language must therefore
   * pass it (`resolveSttLanguage`); one that does not is left exactly as it was,
   * which is why an absent language sends no field at all rather than an empty
   * one.
   *
   * An empty `text` is an answer rather than an error: no words were heard. The
   * caller knows what that means for its own turn — a session opener has nothing
   * to transcribe in the first place, a voice turn heard silence, and an interview
   * answer was not given — so this returns it and leaves the decision there.
   */
  async transcribe(
    audioPath: string,
    model?: string,
    language?: string,
    target?: ProviderTarget
  ): Promise<TranscriptionResult> {
    const baseUrl = (target?.baseUrl ?? this.baseUrl).replace(/\/$/, "");
    if (baseUrl === "") {
      // Named rather than attempted: a relative URL would fail as a parse error
      // that says nothing about which service the deployment never configured.
      throw new Error("no transcription service is configured (AUDIOCPP_BASE_URL)");
    }
    const headers: Record<string, string> = {};
    // A local service has no key; a profile that names one sends it, and only
    // to that profile's endpoint.
    if (target?.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    const formData = new FormData();
    // Handed over as a Blob that reads the file as it is sent. Reading it here
    // would put the whole recording back in the heap — the one copy the upload
    // path was moved to disk to avoid — and several answers being transcribed at
    // once would scale with their combined size.
    const file = await openAsBlob(audioPath, { type: "audio/wav" });
    formData.append("file", file, "audio.wav");
    formData.append("model", model || config.audio.sttModel);
    if (language) {
      formData.append("language", language);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`STT failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as { text?: string; confidence?: number };
      // No words is not a failure. Throwing here made a silent recording — or one
      // the model could find no words in — reach every caller looking exactly like
      // a dead STT service, and each of them then reported a failed transcription
      // to a user who had simply not spoken. A 200 with no text is the service
      // working and hearing nothing; a service that is actually down answers
      // non-200 above, which is the error it looks like. Whitespace is trimmed
      // because a transcript of blank air is the same absent answer as none.
      return {
        text: (data.text ?? "").trim(),
        confidence: data.confidence,
      };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
}

/**
 * Client for the unified Audio Gateway (TTS).
 *
 * Routes to Kokoro or Piper based on the `engine` option.
 * Next.js should only ever need this one client for TTS.
 */
export class AudioGatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = config.audio.gatewayUrl.replace(/\/$/, "");
    this.timeoutMs = config.audio.timeoutMs;
  }

  /**
   * Check if the audio gateway is reachable and which engines are healthy.
   */
  async healthCheck(): Promise<{ kokoro: boolean; piper: boolean; supertonic: boolean }> {
    // No address is a deployment without a synthesis gateway: there is nothing
    // to check, and nothing to report on every boot.
    if (this.baseUrl === "") return { kokoro: false, piper: false, supertonic: false };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return { kokoro: false, piper: false, supertonic: false };
      }

      const data = (await res.json()) as {
        kokoro?: boolean;
        piper?: boolean;
        supertonic?: boolean;
      };
      return {
        kokoro: data.kokoro ?? false,
        piper: data.piper ?? false,
        supertonic: data.supertonic ?? false,
      };
    } catch {
      return { kokoro: false, piper: false, supertonic: false };
    }
  }

  /**
   * The voices the synthesis service reports it holds, or null when the gateway
   * could not be reached or did not relay a list.
   *
   * Null means "cannot tell", which is distinct from an empty array: a
   * deployment must not read an unreachable audio stack as a voice
   * misconfiguration.
   */
  async voiceCatalog(): Promise<string[] | null> {
    if (this.baseUrl === "") return null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as { voices?: unknown };
      if (!Array.isArray(data.voices)) {
        return null;
      }
      return data.voices.filter(
        (voice): voice is string => typeof voice === "string"
      );
    } catch {
      return null;
    }
  }

  /**
   * Text-to-speech through one OpenAI-shaped endpoint: the deployment's gateway
   * when no profile is named, or the profile's own provider when one is.
   * @param text The text to synthesize.
   * @returns Audio buffer (WAV format).
   */
  async synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer> {
    const engine = options?.engine ?? config.audio.defaultEngine;
    const baseUrl = (options?.baseUrl ?? this.baseUrl).replace(/\/$/, "");
    if (baseUrl === "") {
      throw new Error("no synthesis service is configured (AUDIO_GATEWAY_URL)");
    }
    // The OpenAI contract names the engine in `model`, so a deployment turn asks
    // the gateway for its engine there; a profile names its own model instead.
    const model = options?.model ?? engine;
    if (model === undefined) {
      throw new Error("no text-to-speech model or engine is configured for this turn");
    }
    const payload = {
      model,
      input: text,
      voice: options?.voice ?? config.audio.defaultVoice,
      response_format: "wav",
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);

    // Combine the per-request timeout with the caller-provided disconnect signal.
    const signals: AbortSignal[] = [timeoutController.signal];
    if (options?.signal) {
      signals.push(options.signal);
    }
    const signal = AbortSignal.any(signals);

    try {
      const res = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers,
        body,
        signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`TTS failed (${res.status}): ${text}`);
      }

      const contentType = res.headers.get("content-type") || "unknown";
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // The bridge can only read WAV, so an answer in another format is refused
      // here rather than discovered downstream as audio nobody can play.
      if (
        buffer.length < 12 ||
        buffer.toString("ascii", 0, 4) !== "RIFF" ||
        buffer.toString("ascii", 8, 12) !== "WAVE"
      ) {
        throw new Error(`TTS provider answered ${contentType}, not WAV`);
      }

      // The gateway levels the engines against each other: it is where the
      // engine is known, and every caller's audio comes through it. A caller
      // applying a volume of its own would be a second, uninformed opinion.
      console.log(`[AudioGateway] synthesize returned ${buffer.length} bytes content-type=${contentType}`);
      return buffer;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
}

/**
 * Singleton instances for the application.
 */
export const audioClient = new AudioCppClient();
export const audioGateway = new AudioGatewayClient();

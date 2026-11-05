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
import { createSemaphore } from "@/lib/semaphore";

export interface TranscriptionResult {
  text: string;
  confidence?: number;
}

/**
 * Shaping the conversion service applies to one synthesis.
 *
 * Absent means the service's own defaults, which is what every turn used before
 * this existed. A turn sets it only when the deployment configured shaping for
 * that surface — today, the voice agent.
 */
export interface VoiceShaping {
  /** Pitch shift in semitones; zero means the service default. */
  pitchShift: number;
  /** Formant shift in semitones; zero means the service default. */
  formantShift: number;
  /** An F0 method the service advertises; absent means its default. */
  f0Method?: string;
  /** RVC index blend, 0–1; absent means the service default. */
  indexRate?: number;
  /** Consonant protection, 0–0.5; absent means the service default. */
  protect?: number;
  /** Loudness-envelope blend, 0–1; absent means the service default. */
  rmsMixRate?: number;
  /** Pitch median-filter radius; absent means the service default. */
  filterRadius?: number;
  /** Crepe hop length; absent means the service default. */
  crepeHopLength?: number;
  /** Post-conversion DSP chain in the service's own shape; absent means none. */
  effects?: Record<string, unknown>;
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
  /**
   * Conversion this synthesis asks for.
   *
   * Absent leaves the deployment's behaviour exactly as it was. `false` is the
   * explicit opt-out: no conversion request is made and the synthesized audio is
   * delivered unchanged, even while the deployment names a conversion service.
   * An object asks for that shaping.
   */
  conversion?: VoiceShaping | false;
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
 * The synthesis admission bound, shared by every turn in this process.
 *
 * A turn already bounds its own fan-out (`config.audio.synthesisConcurrency`), but
 * a burst of turns still opened one request each against a gateway that serves them
 * one at a time. Under 100 turns the gateway answered 504 for the ones behind its
 * queue. This bound is the process's, so the queue sits where it can be observed and
 * cancelled rather than inside the gateway.
 */
const synthesisSlots = createSemaphore(config.audio.synthesisAdmission);

/** How many syntheses are in flight and waiting, for the metrics route. */
export function synthesisQueueStats(): { inFlight: number; waiting: number } {
  return { inFlight: synthesisSlots.inFlight(), waiting: synthesisSlots.waiting() };
}

/**
 * Whether a buffer carries a RIFF/WAVE header.
 *
 * Both a provider's synthesis answer and the conversion service's answer are
 * checked with this: the bridge can only read WAV, so an answer in another
 * format is refused where it arrives rather than discovered downstream as audio
 * nobody can play.
 */
function isWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
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
    target?: ProviderTarget,
    signal?: AbortSignal
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
    // The caller's turn may end while this request is queued or in flight; its signal
    // is combined with the request's own timeout rather than replacing it.
    const requestSignal =
      signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);

    try {
      const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers,
        body: formData,
        signal: requestSignal,
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
  /** The deployment's conversion service, or an unconfigured one. */
  private readonly conversion: VoiceConversionClient;

  constructor(options?: { timeoutMs?: number; conversion?: VoiceConversionClient }) {
    this.baseUrl = config.audio.gatewayUrl.replace(/\/$/, "");
    // The deployment's 60 s unless a test names its own: the admitted request's
    // timeout is what a test has to observe, and waiting a real minute for it
    // would make the test a soak.
    this.timeoutMs = options?.timeoutMs ?? config.audio.timeoutMs;
    this.conversion = options?.conversion ?? voiceConversion;
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

    // Wait for a slot before the request is built, so its timeout starts when it
    // is sent rather than while it waits for its turn at the bound, and a turn
    // that ends while queued leaves the queue without sending anything.
    const release = await synthesisSlots.acquire(options?.signal);
    try {
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
        if (!isWav(buffer)) {
          throw new Error(`TTS provider answered ${contentType}, not WAV`);
        }

        // The deployment's own voice, when it names a conversion service. This
        // sits after the answer is validated and before any caller receives it,
        // so it covers both a gateway engine and a profile's own endpoint — the
        // one place every synthesized reply passes through.
        const answered = await this.applyVoiceConversion(
          buffer,
          options?.signal,
          options?.conversion
        );

        // The gateway levels the engines against each other: it is where the
        // engine is known, and every caller's audio comes through it. A caller
        // applying a volume of its own would be a second, uninformed opinion.
        console.log(`[AudioGateway] synthesize returned ${answered.length} bytes content-type=${contentType}`);
        return answered;
      } catch (err) {
        clearTimeout(timeout);
        throw err;
      }
    } finally {
      release();
    }
  }

  /**
   * Pass a synthesized answer through the deployment's conversion service, when
   * it names one.
   *
   * `required` is the deployment's setting. A deployment that enabled conversion
   * asked for a voice, so a failure there is the turn's failure; an optional
   * layer is cosmetic and delivers the unconverted answer instead — but it says
   * so, because an enabled deployment never silently speaks in a voice it did
   * not ask for.
   */
  private async applyVoiceConversion(
    buffer: Buffer,
    signal?: AbortSignal,
    conversion?: VoiceShaping | false
  ): Promise<Buffer> {
    // An explicit opt-out wins over the deployment's service: `false` means the
    // turn asked for no voice changer, and no request is made on its behalf.
    if (conversion === false) return buffer;
    if (!this.conversion.configured) return buffer;
    try {
      return await this.conversion.convert(buffer, signal, conversion);
    } catch (error) {
      if (config.audio.ovc.required) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[AudioGateway] voice conversion failed, delivering unconverted audio: ${detail}`
      );
      return buffer;
    }
  }
}

/**
 * Client for the optional voice-conversion service.
 *
 * Converts a synthesized WAV to the service's active model's voice. The source
 * is always one complete WAV per segment, so the whole-file endpoint is used
 * rather than the service's chunked WebSocket: there is nothing to stream that
 * is not already whole, and its offline path renders with the full-file context.
 *
 * The service has one active model, which is what makes the audible voice
 * uniform across engines and profiles. Which model that is belongs to the
 * service's own operator, not to this call.
 */
export class VoiceConversionClient {
  /** An injected endpoint, or undefined to read the deployment's configuration. */
  private readonly explicitBaseUrl?: string;
  private readonly explicitTimeoutMs?: number;
  private readonly explicitActivationTimeoutMs?: number;

  constructor(options?: {
    baseUrl?: string;
    timeoutMs?: number;
    activationTimeoutMs?: number;
  }) {
    this.explicitBaseUrl = options?.baseUrl;
    this.explicitTimeoutMs = options?.timeoutMs;
    this.explicitActivationTimeoutMs = options?.activationTimeoutMs;
  }

  /** Read at call time, so the boot check and health see the current setting. */
  private get baseUrl(): string {
    return (this.explicitBaseUrl ?? config.audio.ovc.url).replace(/\/$/, "");
  }

  private get timeoutMs(): number {
    return this.explicitTimeoutMs ?? config.audio.ovc.timeoutMs;
  }

  private get activationTimeoutMs(): number {
    return this.explicitActivationTimeoutMs ?? config.audio.ovc.activationTimeoutMs;
  }

  /** Whether this deployment names a conversion service. */
  get configured(): boolean {
    return this.baseUrl !== "";
  }

  /** The methods the active model advertises, as last read by the boot check. */
  private advertisedMethods: string[] = [];

  /** Remember what the service advertised, so a turn can be checked without a call. */
  rememberAdvertisedF0Methods(methods: readonly string[]): void {
    this.advertisedMethods = [...methods];
  }

  /** Empty before the service has been read; callers then fall back to the known set. */
  get advertisedF0Methods(): string[] {
    return this.advertisedMethods;
  }

  /**
   * The service's reachability and the model it reports active.
   *
   * Two seconds rather than the conversion timeout: this is read by the
   * runtime's health on every probe, and a service that is down must not make
   * health slow to answer. An unreachable service and a service with no active
   * model are both reported rather than thrown — neither is a reason to refuse
   * to start, and both are what a turn would fail on.
   */
  async status(): Promise<{
    reachable: boolean;
    activeModel: string | null;
    /** The F0 methods the active model's service advertises, or none. */
    f0Methods: string[];
  }> {
    if (this.baseUrl === "") {
      return { reachable: false, activeModel: null, f0Methods: [] };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/models/active`, {
        signal: controller.signal,
      });
      if (!res.ok) return { reachable: false, activeModel: null, f0Methods: [] };

      // `{"active": false}` when the service holds no active model; otherwise
      // the model's metadata, whose `name` is the file name it was activated by
      // and whose `details.f0_methods` is what that model can be asked for.
      const data = (await res.json()) as {
        active?: boolean;
        name?: string;
        details?: { f0_methods?: unknown };
      };
      const advertised = data.details?.f0_methods;
      return {
        reachable: true,
        activeModel: data.active === true && typeof data.name === "string" ? data.name : null,
        f0Methods: Array.isArray(advertised)
          ? advertised.filter((method): method is string => typeof method === "string")
          : [],
      };
    } catch {
      return { reachable: false, activeModel: null, f0Methods: [] };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Activate the model this deployment names.
   *
   * The service keeps its active model in memory only: a restarted service
   * scans the models directory but activates nothing, and until something is
   * active `/api/convert/` answers 200 with the input essentially unchanged.
   * That is worse than a failure — a required deployment cannot tell it is
   * speaking in the wrong voice — so the runtime activates the configured model
   * when it finds the service without one, or with a different one.
   *
   * Activation loads the model and runs a warm-up before it answers, which
   * upstream describes as seconds to a minute of CPU work; it therefore has its
   * own, longer timeout rather than the conversion's.
   */
  async activate(model: string): Promise<void> {
    if (this.baseUrl === "") {
      throw new Error("no voice-conversion service is configured (OVC_URL)");
    }
    if (model === "") {
      throw new Error("no voice-conversion model is configured (OVC_MODEL)");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.activationTimeoutMs);
    try {
      const res = await fetch(
        `${this.baseUrl}/api/models/${encodeURIComponent(model)}/activate`,
        { method: "POST", signal: controller.signal }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`Voice conversion activation failed (${res.status}): ${text}`);
      }
    } catch (err) {
      // An abort here is this request's own timeout, not a caller's
      // cancellation: the boot path has no turn to end. Naming it avoids a
      // bare "This operation was aborted" in the deployment's log.
      if (controller.signal.aborted) {
        throw new Error(
          `Voice conversion activation timed out after ${this.activationTimeoutMs} ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Convert one synthesized WAV.
   *
   * The service declares the multipart file part as `file` in its own
   * `/api/convert/`, and answers WAV. A non-WAV answer is refused here, by the
   * same check a synthesis answer gets.
   */
  async convert(
    wav: Buffer,
    signal?: AbortSignal,
    shaping?: VoiceShaping
  ): Promise<Buffer> {
    if (this.baseUrl === "") {
      // Named rather than attempted, for the reason the transcription client
      // names its missing service: a relative URL fails as a parse error that
      // says nothing about which address was never configured.
      throw new Error("no voice-conversion service is configured (OVC_URL)");
    }

    const formData = new FormData();
    // A copy, because a Buffer's backing store is typed as possibly shared and
    // BlobPart is not. A segment is seconds of audio, so the copy is small; the
    // alternative is casting away the distinction that keeps shared memory out.
    formData.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
    // Only fields the turn actually names are sent. Zero shift is the service
    // default, so sending it would make an unconfigured turn distinguishable
    // from one that names nothing — and a caller that names no shaping sends
    // the byte-for-byte request it sent before this existed.
    if (shaping !== undefined) {
      if (shaping.pitchShift !== 0) {
        formData.append("pitch_shift", String(shaping.pitchShift));
      }
      if (shaping.formantShift !== 0) {
        formData.append("formant_shift", String(shaping.formantShift));
      }
      if (shaping.f0Method !== undefined && shaping.f0Method !== "") {
        formData.append("f0_method", shaping.f0Method);
      }
      if (shaping.indexRate !== undefined) {
        formData.append("index_rate", String(shaping.indexRate));
      }
      if (shaping.protect !== undefined) {
        formData.append("protect", String(shaping.protect));
      }
      if (shaping.rmsMixRate !== undefined) {
        formData.append("rms_mix_rate", String(shaping.rmsMixRate));
      }
      if (shaping.filterRadius !== undefined) {
        formData.append("filter_radius", String(shaping.filterRadius));
      }
      if (shaping.crepeHopLength !== undefined) {
        formData.append("crepe_hop_length", String(shaping.crepeHopLength));
      }
      if (shaping.effects !== undefined && Object.keys(shaping.effects).length > 0) {
        formData.append("effects", JSON.stringify(shaping.effects));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    // A turn may end while conversion is in flight; its signal is combined with
    // this request's own timeout rather than replacing it.
    const requestSignal =
      signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);

    try {
      const res = await fetch(`${this.baseUrl}/api/convert/`, {
        method: "POST",
        body: formData,
        signal: requestSignal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`Voice conversion failed (${res.status}): ${text}`);
      }

      const converted = Buffer.from(await res.arrayBuffer());
      if (!isWav(converted)) {
        throw new Error("Voice conversion answered audio that is not WAV");
      }
      return converted;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
}

/**
 * Singleton instances for the application.
 */
// Declared before the gateway, which takes it as its default: a constructor that
// read it later would touch the binding before this module had initialized it.
export const voiceConversion = new VoiceConversionClient();
export const audioClient = new AudioCppClient();
export const audioGateway = new AudioGatewayClient();

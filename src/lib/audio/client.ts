/**
 * HTTP clients for audio services.
 *
 * audio.cpp → STT (speech-to-text)
 * Audio Gateway → TTS (text-to-speech) via Kokoro or Piper
 *
 * The gateway exposes a single unified endpoint that routes to
 * the selected engine internally.
 */

import config from "@/lib/config";

export interface TranscriptionResult {
  text: string;
  confidence?: number;
}

export interface SynthesizeOptions {
  engine?: "kokoro" | "piper" | "supertonic";
  voice: string;
  model?: string;
  signal?: AbortSignal;
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
    language?: string
  ): Promise<TranscriptionResult> {
    const formData = new FormData();
    const { readFile } = await import("fs/promises");
    const buffer = await readFile(audioPath);
    const blob = new Blob([buffer], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");
    formData.append("model", model || config.audio.sttModel);
    if (language) {
      formData.append("language", language);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
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
   * Text-to-speech: synthesize audio from text via the gateway.
   * @param text The text to synthesize.
   * @param options Optional engine, voice, voice overrides, and abort signal.
   * @returns Audio buffer (WAV format).
   */
  async synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer> {
    const payload: Record<string, string | undefined> = {
      text,
      engine: options?.engine ?? config.audio.defaultEngine,
      voice: options?.voice ?? config.audio.defaultVoice,
    };
    if (options?.model) {
      payload.model = options.model;
    }
    const body = JSON.stringify(payload);

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);

    // Combine the per-request timeout with the caller-provided disconnect signal.
    const signals: AbortSignal[] = [timeoutController.signal];
    if (options?.signal) {
      signals.push(options.signal);
    }
    const signal = AbortSignal.any(signals);

    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

      // Diagnostic: log what the gateway actually returned
      const magic = buffer.slice(0, 16).toString("hex");
      // Decode WAV fmt chunk if present
      let wavInfo = "";
      if (buffer.length >= 36 && buffer.toString("ascii", 0, 4) === "RIFF") {
        const audioFormat = buffer.readUInt16LE(20);
        const numChannels = buffer.readUInt16LE(22);
        const sampleRate = buffer.readUInt32LE(24);
        const bitsPerSample = buffer.readUInt16LE(34);
        wavInfo = ` fmt=${audioFormat} ch=${numChannels} sr=${sampleRate} bps=${bitsPerSample}`;
      }
      console.log(
        `[AudioGateway] synthesize returned ${buffer.length} bytes ` +
          `content-type=${contentType} magic=${magic}${wavInfo}`
      );

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

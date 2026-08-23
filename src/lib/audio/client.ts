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
  engine?: "kokoro" | "piper";
  voice?: string;
  model?: string;
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
   */
  async transcribe(audioPath: string, model?: string): Promise<TranscriptionResult> {
    const formData = new FormData();
    const { readFile } = await import("fs/promises");
    const buffer = await readFile(audioPath);
    const blob = new Blob([buffer], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");
    formData.append("model", model || config.audio.sttModel);

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
      if (!data.text) {
        throw new Error("STT returned empty transcription");
      }

      return {
        text: data.text,
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
  async healthCheck(): Promise<{ kokoro: boolean; piper: boolean }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return { kokoro: false, piper: false };
      }

      const data = (await res.json()) as {
        kokoro?: boolean;
        piper?: boolean;
      };
      return {
        kokoro: data.kokoro ?? false,
        piper: data.piper ?? false,
      };
    } catch {
      return { kokoro: false, piper: false };
    }
  }

  /**
   * Text-to-speech: synthesize audio from text via the gateway.
   * @param text The text to synthesize.
   * @param options Optional engine and voice overrides.
   * @returns Audio buffer (WAV format).
   */
  async synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer> {
    const payload: Record<string, string | undefined> = {
      text,
      engine: options?.engine ?? config.audio.defaultEngine,
    };
    // Only send voice if explicitly provided; downstream services use their own defaults
    if (options?.voice) {
      payload.voice = options.voice;
    }
    if (options?.model) {
      payload.model = options.model;
    }
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
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

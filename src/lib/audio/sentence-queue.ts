/**
 * Imperative sentence-level audio queue with preloading.
 *
 * Manages sequential playback of audio chunks using the Web Audio API.
 * Automatically preloads upcoming chunks in the background so playback
 * is gapless — the next sentence starts immediately when the previous ends.
 *
 * Designed to be called directly from event handlers (e.g. SSE sentence events).
 */

export interface SentenceQueueCallbacks {
  onStart?: (index: number) => void;
  onEnd?: (index: number) => void;
  onError?: (index: number, error: unknown) => void;
  onFinished?: () => void;
}

export interface SentenceQueueOptions extends SentenceQueueCallbacks {
  /** Playback rate. 1.0 = normal, <1.0 = slower, >1.0 = faster. Default: 1.0 */
  playbackRate?: number;
}

interface QueueItem {
  index: number;
  url: string;
  text?: string;
}

export class SentenceAudioQueue {
  private audioCtx: AudioContext;
  private items: QueueItem[] = [];
  private preloaded = new Map<number, AudioBuffer>();
  private currentSource: AudioBufferSourceNode | null = null;
  private isPlaying = false;
  private currentIndex = -1;
  private callbacks: SentenceQueueCallbacks;
  private playbackRate: number;
  private aborted = false;

  constructor(audioCtx: AudioContext, options: SentenceQueueOptions = {}) {
    this.audioCtx = audioCtx;
    const { playbackRate = 1.0, ...callbacks } = options;
    this.playbackRate = playbackRate;
    this.callbacks = callbacks;
  }

  /** Call this whenever a new sentence audio URL arrives. */
  enqueue(index: number, url: string, text?: string) {
    this.items.push({ index, url, text });
    if (!this.isPlaying) {
      this.playNext();
    } else {
      // Preload the newly added item in the background
      this.preloadItem(index, url);
    }
  }

  /** Determine how long to pause after a chunk based on trailing punctuation. */
  private getPauseMs(text: string | undefined): number {
    if (!text) return 0;
    const trimmed = text.trim();

    // Paragraph / ellipsis break (longest pause)
    if (trimmed.endsWith("…") || trimmed.endsWith("...")) return 600;

    // Sentence endings
    if (/[.!?。؟！]$/.test(trimmed)) return 400;

    // Semicolon / colon
    if (trimmed.endsWith(";") || trimmed.endsWith(":")) return 250;

    // Dash
    if (trimmed.endsWith("—") || trimmed.endsWith("-")) return 200;

    // Comma
    if (trimmed.endsWith(",") || trimmed.endsWith("،")) return 180;

    return 0;
  }

  /** Current sentence being played (or -1 if idle). */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /** Whether audio is currently playing. */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /** Remaining items in the queue. */
  getQueueLength(): number {
    return this.items.length;
  }

  /** Stop everything and clear the queue. */
  stop() {
    this.aborted = true;
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch {
        // already stopped
      }
      this.currentSource = null;
    }
    this.items = [];
    this.preloaded.clear();
    this.isPlaying = false;
    this.currentIndex = -1;
  }

  /** Preload a single item in the background (non-blocking). */
  private async preloadItem(index: number, url: string) {
    if (this.preloaded.has(index) || this.aborted) return;

    try {
      const res = await fetch(url);
      if (!res.ok || this.aborted) return;

      const arrayBuffer = await res.arrayBuffer();
      if (this.aborted) return;

      const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
      if (this.aborted) return;

      if (audioBuffer.duration > 0 && Number.isFinite(audioBuffer.duration)) {
        this.preloaded.set(index, audioBuffer);
      }
    } catch {
      // Preload failure is silent — playNext will retry or skip
    }
  }

  private async playNext() {
    if (this.items.length === 0) {
      this.isPlaying = false;
      this.currentIndex = -1;
      this.callbacks.onFinished?.();
      return;
    }

    this.isPlaying = true;
    const item = this.items.shift()!;
    this.currentIndex = item.index;
    this.callbacks.onStart?.(item.index);

    // Resume context if suspended (autoplay policy)
    if (this.audioCtx.state === "suspended") {
      try {
        await this.audioCtx.resume();
      } catch {
        // ignore
      }
    }

    // ── Try preloaded buffer first ──────────────────────────────────────
    let audioBuffer = this.preloaded.get(item.index);
    this.preloaded.delete(item.index); // free memory

    if (!audioBuffer) {
      // Not preloaded yet — fetch + decode now
      try {
        const res = await fetch(item.url);
        if (this.aborted) return;

        if (!res.ok) {
          console.warn(`[SentenceAudioQueue] Fetch failed: ${res.status}`);
          this.callbacks.onError?.(item.index, new Error(`HTTP ${res.status}`));
          this.playNext();
          return;
        }

        const arrayBuffer = await res.arrayBuffer();
        if (this.aborted) return;

        audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
        if (this.aborted) return;
      } catch (err) {
        if (this.aborted) return;
        console.warn("[SentenceAudioQueue] Playback failed:", err);
        this.callbacks.onError?.(item.index, err);
        this.currentSource = null;
        this.playNext();
        return;
      }
    }

    if (!audioBuffer || audioBuffer.duration <= 0 || !Number.isFinite(audioBuffer.duration)) {
      console.warn(`[SentenceAudioQueue] Invalid buffer duration`);
      this.callbacks.onError?.(item.index, new Error("Invalid buffer"));
      this.playNext();
      return;
    }

    if (this.aborted) return;

    // Start playing immediately
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.audioCtx.destination);
    this.currentSource = source;

    const mySource = source;
    source.onended = () => {
      if (this.currentSource !== mySource) return;
      if (this.aborted) return;
      this.currentSource = null;
      this.callbacks.onEnd?.(item.index);

      // If the just-played chunk ends with punctuation that needs a pause,
      // delay the next chunk briefly so the pause feels natural.
      const pauseMs = this.getPauseMs(item.text);
      if (pauseMs > 0 && this.items.length > 0) {
        setTimeout(() => this.playNext(), pauseMs);
      } else {
        this.playNext();
      }
    };

    source.start(0);
  }
}

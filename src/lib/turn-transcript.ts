import { appendFile, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "./config";

/**
 * A turn's windows, as they arrive: what each was transcribed to, and the PCM it
 * carried, held until the turn is submitted.
 *
 * The unit is a window because that is what the client can produce while a person
 * is still speaking. Holding the PCM rather than only its transcript is what lets
 * the recording be assembled from the same pieces transcription used, so the
 * answer is never uploaded twice and the whole-body request disappears.
 *
 * The buffer is in-process, like the prefetch holds and the tool-call waits — the
 * API is one instance, and a turn that spans a restart fails as it would today.
 * What a restart costs is named in the design: the client re-sends the recording.
 */

/**
 * A turn id as the client sends it, or the empty string for anything that names
 * no turn.
 *
 * The id travels in multipart fields, so it is read defensively: bounded in
 * length, and limited to characters that cannot be mistaken for a path or a
 * header value.
 */
export function readTurnId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(trimmed) ? trimmed : "";
}

export interface TurnKey {
  turnId: string;
  /** The session a turn belongs to, when the caller has one; part of the key, so
   *  two clients that invented the same id cannot read each other's turn. */
  sessionId?: string;
}

export type TurnOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string };

export interface TurnClaim {
  /** The whole transcript, or why the turn cannot be answered. */
  outcome: TurnOutcome;
  /** The turn's audio as raw 16 kHz mono 16-bit PCM, in window order. */
  pcmPath: string;
  pcmBytes: number;
}

/** Where a turn's PCM waits. Not under the audio root: a partial answer is not
 *  something the `/audio` mount should be able to serve. */
export const TURN_AUDIO_DIR = join(tmpdir(), "adaptive-interview-turns");

interface HeldTurn {
  text: string;
  /**
   * The window indices already taken.
   *
   * A window may be sent twice — the client retries a request whose answer was
   * lost — and the second copy must not add its text or audio again. The index is
   * the client's own, per turn, from zero.
   */
  seen: Set<number>;
  /** Windows that could not be transcribed, by index. A retry that succeeds
   *  removes its own entry; any entry left here when the turn is claimed is a gap. */
  failures: Map<number, string>;
  /** A failure reported by a client too old to send an index. It cannot be
   *  cleared by a retry, because such a client has no way to say which window it
   *  retried — so it fails the turn until the turn is claimed, as it always did. */
  unindexedFailure: string | null;
  audioPath: string;
  audioBytes: number;
  createdAt: number;
  /** Serializes this turn's appends, so two windows arriving together keep their
   *  order in both the text and the audio. */
  tail: Promise<void>;
}

export interface TurnTranscriptStore {
  /**
   * Append a window. Opens the turn if this is its first window.
   *
   * `pcm` is the window's audio with its container removed — every window is the
   * platform's one format (16 kHz, mono, 16-bit), checked by the route before it
   * gets here.
   */
  appendWindow(key: TurnKey, index: number | null, text: string, pcm: Buffer): Promise<void>;

  /**
   * Record that a window could not be transcribed, by its index.
   *
   * Indexed so a retry of that same window can clear it: a refusal that was
   * transient is not a gap once the window arrives. A failure no retry clears is
   * a gap, and the turn reports it rather than being answered around it.
   *
   * `null` is a client older than the index; see `unindexedFailure`.
   */
  fail(key: TurnKey, index: number | null, message: string): Promise<void>;

  /** Take everything held for the turn, once. `null` for an unknown or expired
   *  turn. The caller owns the PCM path and must `discard` it. */
  claim(key: TurnKey): Promise<TurnClaim | null>;

  /** Remove a claimed turn's PCM. Safe to call twice. */
  discard(claim: TurnClaim): Promise<void>;

  /** Drop turns older than the bound. */
  sweep(now?: number): Promise<void>;

  /** Turns currently held. For tests and diagnostics. */
  size(): number;
}

export function createTurnTranscriptStore(options?: {
  retentionMs?: number;
  now?: () => number;
}): TurnTranscriptStore {
  const retentionMs = options?.retentionMs ?? 15 * 60_000;
  const now = options?.now ?? Date.now;

  const held = new Map<string, HeldTurn>();

  const keyOf = ({ turnId, sessionId }: TurnKey) => `${sessionId ?? ""}\u0000${turnId}`;

  const entryFor = async (key: TurnKey): Promise<HeldTurn> => {
    const id = keyOf(key);
    const existing = held.get(id);
    if (existing) {
      if (now() - existing.createdAt <= retentionMs) return existing;
      held.delete(id);
      await rm(existing.audioPath, { force: true }).catch(() => undefined);
    }

    const entry: HeldTurn = {
      text: "",
      seen: new Set(),
      failures: new Map(),
      unindexedFailure: null,
      audioPath: join(TURN_AUDIO_DIR, `${randomUUID()}.pcm`),
      audioBytes: 0,
      createdAt: now(),
      tail: Promise.resolve(),
    };
    held.set(id, entry);
    return entry;
  };

  return {
    async appendWindow(key, index, text, pcm) {
      const entry = await entryFor(key);

      entry.tail = entry.tail.then(async () => {
        if (index === null) {
          // An older client: nothing identifies the window, so nothing can be
          // de-duplicated, and only the turn's own end can tell whether it all
          // arrived. It is appended exactly as it was before this existed.
          entry.unindexedFailure = null;
        } else {
          // Inside the chain, so two copies arriving together cannot both append.
          if (entry.seen.has(index)) return;
          entry.seen.add(index);

          // This window arrived after all: a failure recorded for it was the
          // answer being lost rather than the window, and it is no longer a gap.
          entry.failures.delete(index);
        }

        await mkdir(TURN_AUDIO_DIR, { recursive: true });
        await appendFile(entry.audioPath, pcm);
        entry.audioBytes += pcm.length;

        const spoken = text.trim();
        if (!spoken) return;
        entry.text = entry.text ? `${entry.text} ${spoken}` : spoken;
      });

      await entry.tail;
    },

    async fail(key, index, message) {
      const entry = await entryFor(key);
      // Outside the append chain: a failure has nothing to keep in order. It
      // survives until the window it names arrives, or the turn is claimed.
      if (index === null) entry.unindexedFailure = message;
      else entry.failures.set(index, message);
    },

    async claim(key) {
      const id = keyOf(key);
      const entry = held.get(id);
      if (!entry) return null;

      held.delete(id);

      if (now() - entry.createdAt > retentionMs) {
        await rm(entry.audioPath, { force: true }).catch(() => undefined);
        return null;
      }

      const failure =
        entry.unindexedFailure ??
        (entry.failures.values().next().value as string | undefined);

      return {
        outcome: failure
          ? { ok: false, message: failure }
          : { ok: true, text: entry.text.trim() },
        pcmPath: entry.audioPath,
        pcmBytes: entry.audioBytes,
      };
    },

    async discard(claim) {
      await rm(claim.pcmPath, { force: true }).catch(() => undefined);
    },

    async sweep(at = now()) {
      for (const [id, entry] of held) {
        if (at - entry.createdAt <= retentionMs) continue;
        held.delete(id);
        await rm(entry.audioPath, { force: true }).catch(() => undefined);
      }
    },

    size: () => held.size,
  };
}

/**
 * The process's buffer.
 *
 * One instance rather than one per router: a turn's windows arrive on
 * `/api/voice/window`, while its turn may be submitted on either the voice route
 * or the voice-agent route. A per-router buffer would leave a turn's transcript
 * in one router and the turn that names it in another.
 */
export const turnTranscripts = createTurnTranscriptStore({
  retentionMs: config.transcriptBuffer.retentionMs,
});

/**
 * Local filesystem storage for audio files.
 * Files are organized under /tmp/audio/{sessionId}/.
 */

import { mkdir, writeFile, readFile, access, unlink, readdir, stat } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const BASE_DIR = process.env.AUDIO_STORAGE_DIR || "/tmp/audio";

/**
 * Names the per-segment files a streamed turn announces. The route builds a
 * segment's prefix from it and the sweep finds segments by it, so both agree on
 * which files are temporary without either reconstructing the other's names.
 *
 * Everything else under the audio root is durable and addressed by a stored
 * message — the canonical `-interviewer` recording of a turn, and the
 * candidate's own upload — so the marker is an allowlist: a file that does not
 * carry it is never a candidate for removal.
 */
export const SEGMENT_MARKER = "interviewer-chunk";

/**
 * Ensure the session audio directory exists.
 */
async function ensureSessionDir(sessionId: string): Promise<string> {
  const dir = join(BASE_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Save an audio blob/buffer to disk for a session.
 * @param sessionId The interview session UUID.
 * @param blob The audio data (Blob or Buffer).
 * @param prefix Filename prefix (e.g. "candidate", "interviewer").
 * @param ext File extension (e.g. "webm", "wav").
 * @returns The relative URL path for serving the file.
 */
export async function saveAudio(
  sessionId: string,
  blob: Blob | Buffer,
  prefix: string,
  ext: string
): Promise<{ filePath: string; urlPath: string }> {
  const dir = await ensureSessionDir(sessionId);
  const id = randomUUID();
  const filename = `${id}-${prefix}.${ext}`;
  const filePath = join(dir, filename);

  let buffer: Buffer;
  if (Buffer.isBuffer(blob)) {
    buffer = blob;
  } else {
    const arrayBuffer = await blob.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  }

  await writeFile(filePath, buffer);
  console.log(`[saveAudio] Wrote ${buffer.length} bytes to ${filePath}`);

  // URL path for serving via Next.js public or custom route
  const urlPath = `/audio/${sessionId}/${filename}`;

  return { filePath, urlPath };
}

/**
 * Read an audio file from disk.
 * @param filePath Absolute path to the audio file.
 * @returns The file buffer.
 */
export async function readAudio(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}

/**
 * Check if an audio file exists.
 */
export async function audioExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect audio format from buffer magic bytes.
 * Returns the recommended file extension (without dot).
 */
export function detectAudioFormat(buffer: Buffer): string {
  if (buffer.length < 4) return "bin";
  const head = buffer.slice(0, 16);
  const hex = head.toString("hex");

  // WAV: starts with RIFF....WAVE
  if (hex.startsWith("52494646") && hex.includes("57415645")) {
    return "wav";
  }
  // MP3: ID3 tag or MPEG sync word
  if (hex.startsWith("494433") || hex.startsWith("ffe7") || hex.startsWith("fff7")) {
    return "mp3";
  }
  // Ogg: OggS
  if (hex.startsWith("4f676753")) {
    return "ogg";
  }
  // FLAC: fLaC
  if (hex.startsWith("664c6143")) {
    return "flac";
  }
  // WebM: 1A 45 DF A3 (EBML)
  if (hex.startsWith("1a45dfa3")) {
    return "webm";
  }
  // Default fallback — if it looks like RIFF but not WAVE, still say wav
  // because some engines return malformed headers
  if (hex.startsWith("52494646")) {
    return "wav";
  }
  return "bin";
}

/**
 * Get the absolute file path from a URL path.
 * Inverse of saveAudio.
 */
export function urlPathToFilePath(urlPath: string): string {
  // urlPath is like /audio/{sessionId}/{filename}
  const relative = urlPath.replace(/^\/audio\//, "");
  return join(BASE_DIR, relative);
}

/**
 * Delete an audio file given its URL path.
 * Silently ignores missing files so callers can safely delete without checking first.
 */
export async function deleteAudio(urlPath: string): Promise<void> {
  const filePath = urlPathToFilePath(urlPath);
  try {
    await unlink(filePath);
    console.log(`[deleteAudio] Removed ${filePath}`);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // File already gone — not an error
      return;
    }
    console.error(`[deleteAudio] Failed to remove ${filePath}:`, err);
    throw err;
  }
}

/**
 * Remove segment files that have outlived their retention window.
 *
 * A turn's segments are announced to a client that fetches each one as it
 * arrives, so they have to outlive the end of their turn by at least as long as
 * a slow fetch takes. Removing them the moment the turn ended is what made an
 * announced segment unretrievable: the last segment's announcement and the
 * cleanup that deleted it sat in adjacent ticks (design D2).
 *
 * Sweeping by age instead makes the window explicit and reclaims in one pass
 * whatever has outlived it — including segments left behind by a turn whose
 * client vanished, which per-turn cleanup could only reclaim if the turn
 * completed. Segment files are small and the window is minutes, so a sweep can
 * be run wherever a cheap, best-effort reclaim fits; a failure to remove one
 * file is not worth failing a turn over, and the next sweep will find it again.
 *
 * Paths are resolved through `urlPathToFilePath` (by way of `deleteAudio`),
 * never rebuilt here: the audio root differs per machine and is read at module
 * load.
 *
 * @param retentionMs How long a segment file may outlive its last write.
 * @param now The clock to age files against, injectable so a test can expire a
 *   file without waiting for the window to pass.
 * @returns The URL paths of the files actually removed.
 */
export async function sweepStaleSegments(
  retentionMs: number,
  now: number = Date.now()
): Promise<string[]> {
  const removed: string[] = [];

  let sessions;
  try {
    sessions = await readdir(BASE_DIR, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return removed; // Nothing has been written yet.
    }
    throw err;
  }

  for (const session of sessions) {
    if (!session.isDirectory()) continue;

    let filenames: string[];
    try {
      filenames = await readdir(join(BASE_DIR, session.name));
    } catch {
      continue; // Raced away between the two reads.
    }

    for (const filename of filenames) {
      if (!filename.includes(SEGMENT_MARKER)) continue;

      const urlPath = `/audio/${session.name}/${filename}`;

      try {
        const { mtimeMs } = await stat(urlPathToFilePath(urlPath));
        if (now - mtimeMs <= retentionMs) continue;
      } catch {
        continue; // Already gone.
      }

      try {
        await deleteAudio(urlPath);
        removed.push(urlPath);
      } catch {
        // Leave it for the next sweep rather than failing the caller.
      }
    }
  }

  if (removed.length > 0) {
    console.log(`[sweepStaleSegments] Removed ${removed.length} aged-out segment file(s)`);
  }

  return removed;
}

/**
 * Local filesystem storage for audio files.
 * Files are organized under /tmp/audio/{sessionId}/.
 */

import { mkdir, writeFile, readFile, access, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const BASE_DIR = process.env.AUDIO_STORAGE_DIR || "/tmp/audio";

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

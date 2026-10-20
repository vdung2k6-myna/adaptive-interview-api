/**
 * Local filesystem storage for audio files.
 * Files are organized under /tmp/audio/{sessionId}/.
 */

import { copyFile, mkdir, writeFile, readFile, access, unlink, readdir, stat } from "fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { writeWavHeader, type WavFmt } from "./wav-utils";
import { extname, isAbsolute, join, relative, resolve, sep } from "path";
import { randomUUID } from "crypto";
// The default import is the `Mime` **instance** `mime@1.6.0` exports, and `lookup` is a method on
// it (`this.types`) rather than a free function — so it is called as `mime.lookup(...)` and not
// destructured off, which would lose `this` and throw on every call.
import mime from "mime";
import { sweepStaleUploads } from "@/lib/upload";

/**
 * The directory the audio mount serves.
 *
 * Exported because a caller can hold a path and needs to know whether the mount would serve it —
 * a music library is the case, and it has to answer that question before it offers a track whose
 * URL would resolve to nothing. Read once, at import: the mount reads the same value when the app
 * is built, and the two must agree about which directory they mean.
 */
export const AUDIO_ROOT = process.env.AUDIO_STORAGE_DIR || "/tmp/audio";

const BASE_DIR = AUDIO_ROOT;

/**
 * The URL path a file under the audio root is served at, or `null` for a file outside it.
 *
 * The mount serves the root at `/audio`, so a file's URL is its path relative to that root — and a
 * file outside the root has **no URL at all**, because the mount is the only thing that serves
 * these and it cannot reach outside what it serves. `null` rather than a guess: a library kept
 * somewhere else would otherwise be a library whose tracks have URLs that do not resolve, which is
 * discovered by a person as silence.
 *
 * Both paths are resolved before they are compared, so a relative one, a symlinked parent or a
 * `..` segment cannot be used to name a file the mount would not serve.
 *
 * Each segment is percent-encoded, because a track's name is a person's and may hold anything —
 * a space, an ampersand, a `#`. `encodeURIComponent` per segment and not `encodeURI` over the
 * whole: the latter leaves `#` and `?` alone, which in a file name are the two characters that
 * would end the path and start something else.
 */
export function urlPathForFile(filePath: string): string | null {
  const root = resolve(BASE_DIR);
  const full = resolve(filePath);
  const within = relative(root, full);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) return null;
  return `/audio/${within.split(sep).map(encodeURIComponent).join("/")}`;
}

/**
 * Containers the mount's own table does not know, and the type to serve them as.
 *
 * `send` resolves media types through `mime@1.6.0`, whose table was last filled in 2017 — so a
 * container that postdates it comes back as `application/octet-stream`, `.opus` among them. A
 * library reading only the mount's own answer would call a mainstream music file "not audio" while
 * the mount handed it over as an opaque blob.
 *
 * An entry's criterion is two things together, and not "a container we can think of": the table
 * lacks it, **and** a browser can play it. A container that is neither — `.ape`, `.wv`, `.dsf`,
 * `.amr` — stays out, because offering a track that can only ever fail to play is nobody's favour.
 */
const CONTAINERS_THE_TABLE_LACKS: Record<string, string> = {
  opus: "audio/ogg",
  m4b: "audio/mp4",
  m4r: "audio/mp4",
};

/**
 * Playlist media types — audio-prefixed, and not tracks.
 *
 * A playlist refers to tracks rather than being one, so offering it would put something nobody can
 * listen to on the shelf a model chooses from. Named rather than left to the `audio/` prefix, which
 * admits `.m3u` (`audio/x-mpegurl`).
 */
const PLAYLIST_MEDIA_TYPES = new Set(["audio/x-mpegurl", "audio/x-scpls", "audio/x-m3u"]);

/**
 * The media type the audio mount serves a file with.
 *
 * **Used by both the mount and the music library, and that is the point.** The library asks "is this
 * a track?" and the mount answers a client; if the two ever read different tables, what the library
 * offers and what a client is handed stop agreeing. A `.opus` track the library lists and the mount
 * serves as `application/octet-stream` is exactly that drift, which is the bug this function exists
 * to make impossible.
 *
 * A container the table cannot resolve answers `application/octet-stream` rather than throwing,
 * because that is what the mount serves; `isServableAudio` is where that becomes "not a track".
 */
export function audioMediaType(filePath: string): string {
  const extension = extname(filePath).slice(1).toLowerCase();
  return CONTAINERS_THE_TABLE_LACKS[extension] ?? mime.lookup(filePath);
}

/**
 * Whether the mount would serve this file as audio — the one question the music library asks of each
 * file it finds, and the reason `audioMediaType` is shared rather than written twice.
 */
export function isServableAudio(filePath: string): boolean {
  const mediaType = audioMediaType(filePath);
  return mediaType.startsWith("audio/") && !PLAYLIST_MEDIA_TYPES.has(mediaType);
}

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
  blob: Blob | Buffer | string,
  prefix: string,
  ext: string
): Promise<{ filePath: string; urlPath: string }> {
  const dir = await ensureSessionDir(sessionId);
  const id = randomUUID();
  const filename = `${id}-${prefix}.${ext}`;
  const filePath = join(dir, filename);

  // A path is copied rather than read: an uploaded recording is already on disk,
  // and reading it here would put the whole recording back in the heap — which is
  // what receiving it on disk was for. `copyFile` streams in the kernel.
  if (typeof blob === "string") {
    await copyFile(blob, filePath);
    console.log(`[saveAudio] Copied ${filePath} from ${blob}`);
    const urlPath = `/audio/${sessionId}/${filename}`;
    return { filePath, urlPath };
  }

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
 * The one format a turn's windows are sent in — the capture contract the
 * `voice-ingest` spec states: one channel at 16 kHz, 16-bit samples.
 *
 * Fixed here rather than carried on the wire: every window is checked against
 * this at the route, so a stream of them can be concatenated by appending bytes
 * with no per-window parsing left to do at the end.
 */
const WINDOW_WAV_FORMAT: WavFmt = {
  audioFormat: 1,
  numChannels: 1,
  sampleRate: 16_000,
  byteRate: 32_000,
  blockAlign: 2,
  bitsPerSample: 16,
};

/**
 * Write a recording assembled from a turn's raw window PCM.
 *
 * The header is written first with the length the PCM ended up having, then the
 * PCM is streamed in behind it — the same order the client's own assembly uses,
 * and for the same reason: nothing has to hold the recording to know its size.
 */
export async function saveAudioFromPcm(
  sessionId: string,
  pcmPath: string,
  pcmBytes: number,
  prefix: string
): Promise<{ filePath: string; urlPath: string }> {
  const dir = await ensureSessionDir(sessionId);
  const filename = `${randomUUID()}-${prefix}.wav`;
  const filePath = join(dir, filename);

  await writeFile(filePath, writeWavHeader(pcmBytes, WINDOW_WAV_FORMAT));
  if (pcmBytes > 0) {
    await pipeline(createReadStream(pcmPath), createWriteStream(filePath, { flags: "a" }));
  }

  console.log(`[saveAudioFromPcm] Wrote ${pcmBytes} PCM bytes to ${filePath}`);
  return { filePath, urlPath: `/audio/${sessionId}/${filename}` };
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

  // An upload that was never consumed — a request that died between multer
  // writing it and the route taking it — is reclaimed by the same sweep, so a
  // crash cannot leave bodies on disk forever. Its age is its own: an upload is
  // dead after an hour, not after the segment window.
  removed.push(...(await sweepStaleUploads(now).catch(() => [])));

  if (removed.length > 0) {
    console.log(`[sweepStaleSegments] Removed ${removed.length} aged-out file(s)`);
  }

  return removed;
}

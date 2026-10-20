import multer from "multer";
import { randomUUID } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a recording waits while it is uploaded, before a route moves it to
 * whatever holds it.
 *
 * On disk rather than in the heap, and that is the whole point: `memoryStorage`
 * made a recording occupy memory in proportion to its length, so several long
 * answers arriving together occupied their sum. The transport's own bound is
 * still what limits length; this only decides where the bytes wait.
 *
 * Not under the audio root, because that root is what the `/audio` mount serves:
 * a half-received body has no business being reachable by URL, even behind the
 * credential.
 */
export const UPLOAD_TEMP_DIR = join(tmpdir(), "adaptive-interview-uploads");

export const audioUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TEMP_DIR,
    // A name no request can predict, so one request cannot name another's file.
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
  }),
});

/**
 * Remove the temporary file an upload was written to.
 *
 * Best-effort, and safe to call twice: a route calls it as soon as it has moved
 * the bytes somewhere durable, and the handler's `finally` calls it again for a
 * request that returned early. A failure leaves a file the sweep will reclaim,
 * which is better than turning a completed turn into an error.
 */
export async function discardUpload(file: Express.Multer.File | undefined): Promise<void> {
  if (!file?.path) return;
  await unlink(file.path).catch(() => undefined);
}

/** An hour: far longer than any upload, short enough that a crash cannot fill the disk. */
export const UPLOAD_MAX_AGE_MS = 60 * 60_000;

/**
 * Reclaim uploads that were never consumed.
 *
 * The case is a request that died between multer writing the body and the route
 * taking it — a process restart, a crash, a connection dropped at the wrong
 * moment. Nothing in the request can clean those up, so age is the only thing
 * that can.
 */
export async function sweepStaleUploads(
  now: number = Date.now(),
  maxAgeMs: number = UPLOAD_MAX_AGE_MS
): Promise<string[]> {
  const removed: string[] = [];

  let names: string[];
  try {
    names = await readdir(UPLOAD_TEMP_DIR);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return removed; // Nothing has been uploaded yet.
    }
    throw err;
  }

  for (const name of names) {
    const filePath = join(UPLOAD_TEMP_DIR, name);
    try {
      const { mtimeMs } = await stat(filePath);
      if (now - mtimeMs <= maxAgeMs) continue;
      await unlink(filePath);
      removed.push(filePath);
    } catch {
      // Already gone, or not ours to read; leave it to the next sweep.
    }
  }

  return removed;
}

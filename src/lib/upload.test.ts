import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";

import { audioUpload, discardUpload, sweepStaleUploads, UPLOAD_TEMP_DIR } from "./upload";

async function withUploadServer(
  fn: (post: (bytes: Buffer) => Promise<{ path: string; size: number; status: number }>) => Promise<void>
): Promise<void> {
  const app = express();
  app.post("/upload", audioUpload.single("audio"), (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "missing" });
      return;
    }
    res.json({ path: file.path, size: file.size });
  });

  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await fn(async (bytes) => {
      const form = new FormData();
      const part = new Uint8Array(bytes.byteLength);
      part.set(bytes);
      form.append("audio", new Blob([part], { type: "audio/wav" }), "answer.wav");
      const response = await fetch(`http://127.0.0.1:${address.port}/upload`, {
        method: "POST",
        body: form,
      });
      const body = (await response.json()) as { path?: string; size?: number };
      return { path: body.path ?? "", size: body.size ?? 0, status: response.status };
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("audioUpload", () => {
  before(async () => {
    await mkdir(UPLOAD_TEMP_DIR, { recursive: true });
  });

  it("writes the whole recording to disk as it arrives", async () => {
    const bytes = Buffer.alloc(256 * 1024, 7);

    await withUploadServer(async (post) => {
      const result = await post(bytes);

      assert.equal(result.status, 200);
      assert.equal(result.size, bytes.length, "multer reports the bytes it received");
      assert.equal((await stat(result.path)).size, bytes.length, "and the file holds them all");

      await discardUpload({ path: result.path } as Express.Multer.File);
    });
  });

  it("removes the temporary file, and tolerates one that is already gone", async () => {
    await withUploadServer(async (post) => {
      const result = await post(Buffer.from("audio"));

      await discardUpload({ path: result.path } as Express.Multer.File);
      await assert.rejects(stat(result.path), "the file is gone after discard");

      // A second call is what a handler's `finally` does after the route has
      // already cleaned up; it must not turn a finished turn into an error.
      await discardUpload({ path: result.path } as Express.Multer.File);
      await discardUpload(undefined);
    });
  });

  it("reclaims only uploads older than the age bound", async () => {
    const fresh = join(UPLOAD_TEMP_DIR, "sweep-test-fresh.upload");
    const stale = join(UPLOAD_TEMP_DIR, "sweep-test-stale.upload");
    await writeFile(fresh, "fresh");
    await writeFile(stale, "stale");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    const removed = await sweepStaleUploads();

    assert.ok(removed.includes(stale), "an orphan is reclaimed");
    assert.ok(!removed.includes(fresh), "an upload still in flight is not");

    const remaining = await readdir(UPLOAD_TEMP_DIR);
    assert.ok(remaining.includes("sweep-test-fresh.upload"));
    assert.ok(!remaining.includes("sweep-test-stale.upload"));

    await discardUpload({ path: fresh } as Express.Multer.File);
  });
});

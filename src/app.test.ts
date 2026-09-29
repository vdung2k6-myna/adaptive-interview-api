import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createApp } from "./app";

/** The token this suite arms auth with. Deliberately not the developer's: the
 * assertions below are about which requests auth answers, and an unset
 * `API_AUTH_TOKEN` disables authentication entirely, which would make the
 * authenticated-resource assertion pass for the wrong reason. */
const TOKEN = "test-token-for-the-composition-root";

/** The session directory and file the present-file case is served from. The
 * path shape is the one audio is stored and requested under, so the missing-file
 * case below is the same kind of request as the one that failed in production:
 * a segment swept at the end of a turn. */
const SESSION = "e21e2a7d-f5e9-42ed-9c3c-452e04cfa725";
const PRESENT = "present-segment.wav";
const SWEPT = "swept-segment.wav";

/** Where each request in this suite goes. */
interface Urls {
  /** A segment file that exists. */
  present: string;
  /** A segment file that was there and is not any more. */
  swept: string;
  /** A path under the audio mount with no shape claimed for it at all. */
  outside: string;
  /** An authenticated API resource the suite may request without a token. */
  api: string;
  /** The persona catalog, the other authenticated resource this suite asks for. */
  catalog: string;
  /** A public resource. */
  health: string;
}

/**
 * Serve the composition root on an ephemeral port over a private audio
 * directory holding exactly one file, so what a request is answered with comes
 * from the mount order under test and not from this machine's storage.
 *
 * The audio root is read when the app is built, so the environment is set around
 * `createApp()` and restored afterwards — one suite's storage must not decide
 * another's answer, and the developer's `.env` must not decide this one's.
 */
async function withApp(fn: (urls: Urls) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "composition-root-audio-"));
  await mkdir(join(dir, SESSION), { recursive: true });
  await writeFile(join(dir, SESSION, PRESENT), Buffer.from("RIFF0000WAVEfmt "));

  const previousDir = process.env.AUDIO_STORAGE_DIR;
  const previousToken = process.env.API_AUTH_TOKEN;
  process.env.AUDIO_STORAGE_DIR = dir;
  process.env.API_AUTH_TOKEN = TOKEN;

  let server: Server | undefined;
  try {
    const app = createApp();
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object", "expected the app to bind a port");
    const base = `http://127.0.0.1:${address.port}`;

    await fn({
      present: `${base}/audio/${SESSION}/${PRESENT}`,
      swept: `${base}/audio/${SESSION}/${SWEPT}`,
      outside: `${base}/audio/no-such-session.wav`,
      api: `${base}/api/sessions`,
      catalog: `${base}/api/personas`,
      health: `${base}/health`,
    });
  } finally {
    if (server) {
      // A keep-alive socket would otherwise hold `close()` open for its idle
      // timeout. Nothing here streams, but the client pool is shared.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });

    if (previousDir === undefined) delete process.env.AUDIO_STORAGE_DIR;
    else process.env.AUDIO_STORAGE_DIR = previousDir;

    if (previousToken === undefined) delete process.env.API_AUTH_TOKEN;
    else process.env.API_AUTH_TOKEN = previousToken;
  }
}

describe("composition root: which middleware answers a request", () => {
  it("serves audio that is there, with no credentials", async () => {
    await withApp(async (urls) => {
      const res = await fetch(urls.present);

      assert.equal(res.status, 200);
      assert.equal(await res.text(), "RIFF0000WAVEfmt ");
    });
  });

  it("answers audio that is gone with 404, not an authentication failure", async () => {
    await withApp(async (urls) => {
      const res = await fetch(urls.swept);

      assert.equal(
        res.status,
        404,
        "a file that is not there must not be reported as a rejected credential"
      );
    });
  });

  it("answers a missing audio path with 404 whether or not credentials are sent", async () => {
    await withApp(async (urls) => {
      const bare = await fetch(urls.outside);
      const credentialed = await fetch(urls.outside, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      assert.equal(bare.status, 404);
      assert.equal(
        credentialed.status,
        404,
        "a valid token must not change what a missing file is reported as"
      );
    });
  });

  it("still requires credentials for an authenticated resource", async () => {
    await withApp(async (urls) => {
      const res = await fetch(urls.api);

      assert.equal(res.status, 401, "scoping auth to /api must not unauthenticate the API");
    });
  });

  it("requires credentials for the persona catalog too, as for every resource under /api", async () => {
    await withApp(async (urls) => {
      const res = await fetch(urls.catalog);

      assert.equal(
        res.status,
        401,
        "the catalog is mounted under /api, so a client that is not signed in must not read it — and a mount that was missing or ordered after the error handler would answer 404 instead"
      );
    });
  });

  it("leaves the public health check reachable", async () => {
    await withApp(async (urls) => {
      const res = await fetch(urls.health);

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        status: "ok",
        service: "adaptive-interview-api",
      });
    });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createApp } from "./app";

/** The token this suite arms auth with. Deliberately not the developer's: the
 * assertions below are about which requests auth answers, and an unset
 * `API_AUTH_TOKEN` disables authentication entirely, which would make every
 * authenticated-resource assertion pass for the wrong reason — the audio refusals
 * among them, since a disabled credential refuses nothing. */
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
  const bearer = (): Record<string, string> => ({ Authorization: `Bearer ${TOKEN}` });

  it("serves a recording to a caller that presents the credential", async () => {
    await withApp(async (urls) => {
      const res = await fetch(urls.present, { headers: bearer() });

      assert.equal(res.status, 200);
      assert.equal(await res.text(), "RIFF0000WAVEfmt ");
    });
  });

  it("refuses a recording to a caller that does not, rather than serving it by URL", async () => {
    // The whole of this change. A recording used to be served to anyone holding its
    // URL: the mount sat before the middleware, and this deployment's ingress forwards
    // `/audio` as well as `/api`. Two UUIDs of secrecy is not a credential, and a URL
    // leaks into payloads, browser history and logs.
    await withApp(async (urls) => {
      const res = await fetch(urls.present);

      assert.equal(res.status, 401, "a recording is not readable by its URL alone");
      assert.notEqual(await res.text(), "RIFF0000WAVEfmt ", "and its bytes are not in the refusal");
    });
  });

  it("refuses a path that holds nothing exactly as it refuses one that holds a recording", async () => {
    // A change of the answer this file used to pin. The mount was placed before the
    // middleware so that a segment swept at the end of a turn would be answered as
    // absent (404) rather than as a rejected credential (401). Behind the middleware
    // both are 401, which is the wanted answer: a 404-versus-401 difference tells an
    // unauthenticated caller which recordings exist.
    await withApp(async (urls) => {
      const swept = await fetch(urls.swept);
      const present = await fetch(urls.present);
      const outside = await fetch(urls.outside);

      assert.equal(swept.status, 401);
      assert.equal(outside.status, 401);
      assert.equal(
        present.status,
        swept.status,
        "the two must not be told apart by a caller who may read neither"
      );
    });
  });

  it("tells an authenticated caller what is actually there", async () => {
    // A caller holding the credential may read these files, so it may also learn that
    // one is missing: a 404 here is information the platform is entitled to give, and
    // it is the same 404 the mount answered before.
    await withApp(async (urls) => {
      const swept = await fetch(urls.swept, { headers: bearer() });
      const outside = await fetch(urls.outside, { headers: bearer() });

      assert.equal(swept.status, 404, "a segment that was swept is gone, and says so");
      assert.equal(outside.status, 404);
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

describe("composition root: the media type the audio mount serves", () => {
  /**
   * Serve the audio root over a directory holding one file per container, so the
   * assertion is about the mount's own answer rather than about a table read
   * anywhere else. A sibling of `withApp` rather than a change to it: its cases
   * assert what the directory holds, and adding files would answer those for it.
   */
  async function withContainers(names: string[], fn: (base: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "composition-root-types-"));
    for (const name of names) await writeFile(join(dir, name), Buffer.from("RIFF0000WAVEfmt "));

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

      await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      if (server) {
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

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${TOKEN}` });

  it("serves every container the library would offer with an audio type", async () => {
    // The mount's half of the one table (`audioMediaType`): a track the library lists must not
    // arrive as an opaque stream, which is exactly what `send`'s own table answers for `.opus`.
    const names = ["a.mp3", "a.wav", "a.flac", "a.opus", "a.m4b", "a.weba"];
    await withContainers(names, async (base) => {
      for (const name of names) {
        const res = await fetch(`${base}/audio/${name}`, { headers: auth() });

        assert.equal(res.status, 200, `${name} is served`);
        assert.match(
          String(res.headers.get("content-type")),
          /^audio\//,
          `${name} arrives as audio, and not as an opaque stream`
        );
        await res.text();
      }
    });
  });

  it("answers .opus with the type the supplement supplies, not the table's opaque default", async () => {
    await withContainers(["a.opus"], async (base) => {
      const res = await fetch(`${base}/audio/a.opus`, { headers: auth() });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "audio/ogg");
      await res.text();
    });
  });

  it("still serves a file that is not audio, with a type that is not audio", async () => {
    // The mount is not the gate — the library is. Serving the bytes is unchanged; what this pins is
    // that the mount does not *call* a thumbnail cache audio, which is what the library reads.
    await withContainers(["Thumbs.db"], async (base) => {
      const res = await fetch(`${base}/audio/Thumbs.db`, { headers: auth() });

      assert.equal(res.status, 200);
      assert.doesNotMatch(String(res.headers.get("content-type")), /^audio\//);
      await res.text();
    });
  });
});

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMusicRouter, type LibraryAnswer, type MusicDeps } from "./music";
import { apiAuthMiddleware } from "../middleware/auth";
import { AUDIO_ROOT } from "../lib/audio/storage";

/**
 * The library as the client reads it.
 *
 * Mounted behind the real auth middleware on a bare app and bound to an ephemeral port, so the answer
 * is asserted over HTTP through the middleware the composition root puts in front of it — the same
 * shape the persona catalog's suite takes, and for the same reason: one half of the requirement is that
 * a credentialed caller reaches it, and the other is that an uncredentialed one does not.
 */

/** The token this suite arms auth with. Deliberately not the developer's: an unset `API_AUTH_TOKEN`
 *  disables authentication entirely, which would make the unauthorized assertion pass for the wrong
 *  reason. */
const TOKEN = "test-token-for-the-music-library";

/** A uniquely-named directory under `parent`, removed when this file finishes. */
const made: string[] = [];
async function dirUnder(parent: string): Promise<string> {
  const dir = await mkdtemp(join(parent, "music-route-suite-"));
  made.push(dir);
  return dir;
}

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A file the mount would serve, written where it holds nothing but bytes. */
const track = (path: string) => writeFile(path, Buffer.from("RIFF0000WAVEfmt "));

/** The library as bound for one test. */
interface Library {
  /** Where it is. A request here without `authorized` carries no credential. */
  url: string;
  /** A request the auth middleware accepts, and the answer it was given. */
  authorized: () => Promise<LibraryAnswer>;
}

async function withServer(
  deps: Partial<MusicDeps>,
  fn: (library: Library) => Promise<void>
): Promise<void> {
  const previousToken = process.env.API_AUTH_TOKEN;
  process.env.API_AUTH_TOKEN = TOKEN;

  const app = express();
  app.use(express.json());
  app.use("/api", apiAuthMiddleware);
  app.use("/api/music", createMusicRouter(deps));

  let server: Server | undefined;
  try {
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object", "expected the app to bind a port");
    const url = `http://127.0.0.1:${address.port}/api/music`;

    await fn({
      url,
      authorized: async () => (await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })).json(),
    });
  } finally {
    if (server) {
      // A keep-alive socket would otherwise hold `close()` open for its idle timeout.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }

    if (previousToken === undefined) delete process.env.API_AUTH_TOKEN;
    else process.env.API_AUTH_TOKEN = previousToken;
  }
}

describe("GET /api/music", () => {
  it("answers a request with no credential as unauthorized, as every API resource does", async () => {
    await withServer({ libraryDir: "" }, async (library) => {
      const res = await fetch(library.url);

      assert.equal(res.status, 401);
    });
  });

  it("answers the tracks the deployment holds, named and addressed, in the order they are held", async () => {
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "Diem Xua.mp3"));
    await track(join(dir, "Back in Black.flac"));
    await track(join(dir, "Mot Hai.opus"));
    await writeFile(join(dir, "notes.txt"), "not a track");

    await withServer({ libraryDir: dir }, async (library) => {
      const answer = await library.authorized();

      assert.equal(answer.report, null, "there is something to play, so there is nothing to report");
      assert.deepEqual(
        answer.tracks.map((entry) => entry.title).sort(),
        ["Back in Black", "Diem Xua", "Mot Hai"],
        "every track the directory holds whatever container it is kept in, and no file that is not one"
      );
      for (const entry of answer.tracks) {
        assert.ok(
          entry.url.startsWith(`/audio/${dir.split(/[\\/]/).pop()}/`),
          `a URL under the mount that serves it, and not one that resolves to nothing: ${entry.url}`
        );
        assert.match(entry.url, /\.(mp3|flac|opus)$/, "and one a client can fetch");
      }
    });
  });

  it("answers that there is nothing to play where no library is configured, rather than an empty list", async () => {
    await withServer({ libraryDir: "" }, async (library) => {
      const answer = await library.authorized();

      assert.deepEqual(answer.tracks, [], "no tracks, because there is no library");
      assert.match(
        answer.report ?? "",
        /no music library/,
        "and the answer says which it is: nothing to play, not a shelf that happens to be empty"
      );
    });
  });

  it("answers a library the mount cannot serve with its reason, rather than a URL that resolves to nothing", async () => {
    // Outside the audio root, which is the one configuration that would otherwise be silent and total:
    // every track offered, every URL a 404.
    const outside = await dirUnder(tmpdir());
    await track(join(outside, "Somewhere Else.mp3"));

    await withServer({ libraryDir: outside }, async (library) => {
      const answer = await library.authorized();

      assert.deepEqual(answer.tracks, []);
      assert.match(answer.report ?? "", /not inside the audio root/);
    });
  });

  it("answers an empty library that there is nothing to play, rather than a shelf of nothing", async () => {
    const dir = await dirUnder(AUDIO_ROOT);

    await withServer({ libraryDir: dir }, async (library) => {
      const answer = await library.authorized();

      assert.deepEqual(answer.tracks, []);
      assert.match(answer.report ?? "", /holds no track this service can serve/);
    });
  });
});

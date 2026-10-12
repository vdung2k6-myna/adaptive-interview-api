import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUDIO_ROOT } from "./audio/storage";
import { libraryComplaint, readLibrary, trackNamed } from "./music";

/**
 * The library, over directories this suite makes rather than over a deployment's.
 *
 * Two of them, because the question the module answers has two halves: what a directory holds, and
 * whether the mount would serve it. The first has to be **inside the audio root** — a track
 * anywhere else has no URL, which is the second case.
 */

/** A uniquely-named directory under `parent`, so two suites and a developer's own storage cannot
 *  collide. Removed when this file finishes, whatever it asserted in between. */
const made: string[] = [];
async function dirUnder(parent: string): Promise<string> {
  const dir = await mkdtemp(join(parent, "music-suite-"));
  made.push(dir);
  return dir;
}

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** Answer every request, except the ones in `missing`, the way a swept file answers. */
const track = (name: string) => writeFile(join(name), Buffer.from("RIFF0000WAVEfmt "));

describe("the tracks a directory holds", () => {
  it("answers with the names a person would ask for them by", async () => {
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "Diem Xua.mp3"));
    await track(join(dir, "Back in Black.mp3"));
    await writeFile(join(dir, "notes.txt"), "not a track");

    const library = await readLibrary(dir);

    assert.ok(library.ok, "the directory holds tracks");
    assert.deepEqual(
      library.tracks.map((t) => t.title).sort(),
      ["Back in Black", "Diem Xua"],
      "the file's own name without its extension, and only the mp3s"
    );
    assert.equal(
      library.tracks[0]!.url.startsWith("/audio/"),
      true,
      "and a URL the mount serves, which is what a client fetches"
    );
  });

  it("holds a track filed in a folder, rather than passing over it in silence", async () => {
    // The reading the bridge takes of its own library, and for the same reason: a person's music is
    // filed in folders, and a track that exists being invisible is the one thing a listing cannot
    // be.
    const dir = await dirUnder(AUDIO_ROOT);
    await mkdir(join(dir, "Album One"));
    await track(join(dir, "Album One", "Deep Track.mp3"));

    const library = await readLibrary(dir);

    assert.ok(library.ok);
    assert.deepEqual(library.tracks.map((t) => t.title), ["Deep Track"]);
    assert.match(
      library.tracks[0]!.url,
      /^\/audio\/music-suite-[^/]+\/Album%20One\/Deep%20Track\.mp3$/,
      "with each segment encoded, because a track's name may hold anything"
    );
  });

  it("answers an empty directory as a library with no tracks, rather than as a failure", async () => {
    const dir = await dirUnder(AUDIO_ROOT);

    const library = await readLibrary(dir);

    assert.ok(library.ok, "nothing there is not the same thing as nothing configured");
    assert.deepEqual(library.tracks, []);
  });

  it("reports a directory it cannot read, with the reason", async () => {
    const library = await readLibrary(join(tmpdir(), "no-such-music-directory-here"));

    assert.equal(library.ok, false);
    assert.match(library.ok === false ? library.detail : "", /could not be listed/);
  });
});

describe("a library the mount would not serve", () => {
  it("is reported rather than offered, because a track in it has no URL at all", async () => {
    // The one failure that would otherwise be silent and total: every name offered, every URL a
    // 404. `null` from the mount's own rule, turned into a reason an operator can act on.
    const outside = await dirUnder(tmpdir());
    await track(join(outside, "Somewhere Else.mp3"));

    const library = await readLibrary(outside);

    assert.equal(library.ok, false);
    assert.match(library.ok === false ? library.detail : "", /not inside the audio root/);
  });

  it("says so at boot, once, through the same answer", async () => {
    const outside = await dirUnder(tmpdir());
    await track(join(outside, "Somewhere Else.mp3"));

    assert.match(String(await libraryComplaint(outside)), /not inside the audio root/);
    assert.equal(
      await libraryComplaint(await dirUnder(tmpdir())),
      null,
      "and an empty directory outside the root has nothing to report: there is nothing in it to serve"
    );
    assert.equal(await libraryComplaint(""), null, "and a deployment with no library has nothing to report");
  });
});

describe("the track a name asks for", () => {
  const withTracks = async () => {
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "Diem Xua.mp3"));
    await track(join(dir, "Mot Hai.mp3"));
    return readLibrary(dir);
  };

  it("finds the name the library itself reported", async () => {
    const found = trackNamed(await withTracks(), "Diem Xua");

    assert.ok(found.ok);
    assert.equal(found.track.title, "Diem Xua");
  });

  it("finds it when the model echoes it back in another case", async () => {
    // The same name and not a different one: a model that lowercases what it was given is not
    // making a request this library should refuse.
    const found = trackNamed(await withTracks(), "  diem xua  ");

    assert.ok(found.ok);
    assert.equal(found.track.title, "Diem Xua");
  });

  it("reports a name no track carries rather than playing the nearest one", async () => {
    // The whole of what this module does not do: it does not fold, does not score a run of words,
    // and does not settle between files. A name the shelf did not report is a name the library does
    // not hold.
    const found = trackNamed(await withTracks(), "diem");

    assert.equal(found.ok, false);
    assert.match(found.ok === false ? found.detail : "", /holds no track called diem/);
  });

  it("serves the name exactly as the library reported it, even where a sibling differs by case", async () => {
    // Asking for `Same` is asking for the track the library called `Same` — the name as it was
    // reported, and not a choice between two files.
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "Same.mp3"));
    await track(join(dir, "same.mp3"));

    const found = trackNamed(await readLibrary(dir), "Same");

    assert.ok(found.ok);
    assert.equal(found.track.title, "Same");
  });

  it(
    "reports a name that two tracks answer to rather than choosing between them",
    {
      // Unreachable here, and not because the branch is dead: two files whose names differ only by
      // case cannot both exist on the filesystem this root is on, so the case that reaches it can
      // only be built where they can. Left named and skipped so that a deployment on such a
      // filesystem — and a later reader — can see the branch is meant to be exercised.
      skip: "needs a case-sensitive filesystem, where two names differing only by case can coexist",
    },
    async () => {
      const dir = await dirUnder(AUDIO_ROOT);
      await track(join(dir, "Same.mp3"));
      await track(join(dir, "same.mp3"));

      const found = trackNamed(await readLibrary(dir), "SAME");

      assert.equal(found.ok, false);
      assert.match(found.ok === false ? found.detail : "", /2 tracks are called SAME/);
    }
  );
});

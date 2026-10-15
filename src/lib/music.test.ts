import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUDIO_ROOT } from "./audio/storage";
import { libraryComplaint, readLibrary } from "./music";

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
      "the file's own name without its extension, and nothing that is not audio"
    );
    assert.equal(
      library.tracks[0]!.url.startsWith("/audio/"),
      true,
      "and a URL the mount serves, which is what a client fetches"
    );
  });

  it("is a library whatever container the tracks are kept in", async () => {
    // What the library asks of a file is what the mount would serve it as, not what it is named — so
    // a collection in `.flac`, `.wav` or `.opus` is a collection, and a collection of cover art and
    // caches is not.
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "Mot Hai.flac"));
    await track(join(dir, "Ba Bon.wav"));
    await track(join(dir, "Nam Sau.opus"));
    await writeFile(join(dir, "cover.jpg"), "not audio");
    await writeFile(join(dir, "Thumbs.db"), "not audio either");

    const library = await readLibrary(dir);

    assert.ok(library.ok);
    assert.deepEqual(
      library.tracks.map((t) => t.title).sort(),
      ["Ba Bon", "Mot Hai", "Nam Sau"],
      "every audio container, and nothing that is not audio"
    );
  });

  it("holds a directory of flac as a library rather than as an empty one", async () => {
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "Only Track.flac"));

    const library = await readLibrary(dir);

    assert.ok(library.ok, "a library the old test would have called empty");
    assert.deepEqual(library.tracks.map((t) => t.title), ["Only Track"]);
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

describe("the library as a shelf a caller numbers", () => {
  const withTracks = async () => {
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "Diem Xua.mp3"));
    await track(join(dir, "Mot Hai.mp3"));
    return readLibrary(dir);
  };

  it("reports every track it read, and nothing that is not one", async () => {
    const library = await withTracks();

    assert.ok(library.ok);
    assert.deepEqual(
      [...library.tracks.map((entry) => entry.title)].sort(),
      ["Diem Xua", "Mot Hai"],
      "what a caller numbers is what the directory holds — the order itself is the reading's own, " +
        "which is why a turn holds the shelf it offered rather than reading again for each call"
    );
  });

  it("answers with a name no name was invented for", async () => {
    // The library's own file name without its extension, and not something this service made up.
    // What a person would ask for a track by is a question for whoever named the files.
    const library = await withTracks();

    assert.ok(library.ok);
    assert.ok(
      library.tracks.every((entry) => !/\.mp3$/.test(entry.title)),
      "the extension is the file system's, not a track's"
    );
  });
});

describe("a library pointed at the audio root", () => {
  it("is refused, because the root holds every session's recordings", async () => {
    // A session's recordings live directly beneath the root, and a candidate's answer is written as
    // `.wav` — which is audio, so the container rule cannot be the thing that keeps it out. A library
    // pointed at the root would walk those directories and offer a person's own voice as a track.
    const library = await readLibrary(AUDIO_ROOT);

    assert.equal(library.ok, false);
    assert.match(library.ok === false ? library.detail : "", /is the audio root/);
    assert.match(String(await libraryComplaint(AUDIO_ROOT)), /is the audio root/, "and says so at boot");
  });

  it("leaves a library inside the root alone, which is where one belongs", async () => {
    const dir = await dirUnder(AUDIO_ROOT);
    await track(join(dir, "A Track.mp3"));

    const library = await readLibrary(dir);

    assert.ok(library.ok, "refusing the root must not refuse every directory beneath it");
    assert.deepEqual(library.tracks.map((t) => t.title), ["A Track"]);
  });
});

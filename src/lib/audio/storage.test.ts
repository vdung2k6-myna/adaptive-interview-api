import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { parseWav } from "./wav-utils";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Type-only, so it is erased and does not evaluate `storage.ts` — which would
 * pin `AUDIO_STORAGE_DIR` before the hook below can point it at a temp root. */
import type * as StorageModule from "./storage";

/**
 * `storage.ts` reads `AUDIO_STORAGE_DIR` into a module-level constant, so the
 * audio root has to be in place before the module is first evaluated. A static
 * import is hoisted above any assignment, so the import has to be dynamic and
 * the root has to be made in a hook — inside an `it` would be too late.
 */
let root: string;
let previousRoot: string | undefined;
let storage: typeof StorageModule;

const SESSION = "e21e2a7d-f5e9-42ed-9c3c-452e04cfa725";
const RETENTION_MS = 5 * 60_000;

/** A moment past the retention window, so a file written now has aged out
 * without the suite having to wait for it — the window is injected, not waited
 * on. */
const pastTheWindow = () => Date.now() + RETENTION_MS + 1_000;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "audio-sweep-"));
  previousRoot = process.env.AUDIO_STORAGE_DIR;
  process.env.AUDIO_STORAGE_DIR = root;
  storage = await import("./storage.js");
});

after(async () => {
  if (previousRoot === undefined) delete process.env.AUDIO_STORAGE_DIR;
  else process.env.AUDIO_STORAGE_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
});

/** The session directory is emptied between cases so a sweep's return value
 * counts only the files the case under test wrote. */
beforeEach(async () => {
  await rm(join(root, SESSION), { recursive: true, force: true });
  await mkdir(join(root, SESSION), { recursive: true });
});

/** Write a file into the session directory under the given name, the way the
 * routes do, and return its URL path. */
async function write(name: string): Promise<string> {
  await writeFile(join(root, SESSION, name), Buffer.from("RIFF0000WAVEfmt "));
  return `/audio/${SESSION}/${name}`;
}

/** The names left in the session directory. */
async function remaining(): Promise<string[]> {
  return (await readdir(join(root, SESSION))).sort();
}

describe("sweepStaleSegments", () => {
  it("leaves a segment announced this turn where the client can still fetch it", async () => {
    // The route writes a segment and announces it; its turn then ends. The sweep
    // that runs at the end of that turn is the one that used to be a delete.
    const segment = await write(`${SESSION}-${storage.SEGMENT_MARKER}-0.wav`);

    const removed = await storage.sweepStaleSegments(RETENTION_MS);

    assert.deepEqual(removed, [], "a segment just written has not aged out");
    await access(join(root, SESSION, `${SESSION}-${storage.SEGMENT_MARKER}-0.wav`));
    assert.equal(
      await storage.urlPathToFilePath(segment),
      join(root, SESSION, `${SESSION}-${storage.SEGMENT_MARKER}-0.wav`),
      "the announced URL still resolves to the file"
    );
  });

  it("removes segments once the window has passed, and reports them", async () => {
    const first = await write(`${SESSION}-${storage.SEGMENT_MARKER}-0.wav`);
    const second = await write(`${SESSION}-${storage.SEGMENT_MARKER}-1.wav`);

    const removed = await storage.sweepStaleSegments(RETENTION_MS, pastTheWindow());

    assert.deepEqual(removed.sort(), [first, second].sort());
    assert.deepEqual(await remaining(), [], "both aged-out segments are gone");
  });

  it("leaves the canonical recording alone, however old it is", async () => {
    // The canonical file is what a stored message addresses for playback, so it
    // is durable: the sweep must not be able to reach it even when it is the
    // oldest thing in the directory.
    const canonical = "30ba063c-b694-4a73-aa4b-4604990886b8-interviewer.wav";
    await write(canonical);
    await write(`${SESSION}-${storage.SEGMENT_MARKER}-0.wav`);

    const removed = await storage.sweepStaleSegments(RETENTION_MS, pastTheWindow());

    assert.deepEqual(removed, [`/audio/${SESSION}/${SESSION}-${storage.SEGMENT_MARKER}-0.wav`]);
    assert.deepEqual(await remaining(), [canonical]);
  });

  it("leaves the candidate's own upload alone, however old it is", async () => {
    const candidate = "08a0941b-23a1-459d-9847-4d9c3d325774-candidate.webm";
    await write(candidate);

    const removed = await storage.sweepStaleSegments(RETENTION_MS, pastTheWindow());

    assert.deepEqual(removed, []);
    assert.deepEqual(await remaining(), [candidate]);
  });

  it("sweeps a session it was not told about", async () => {
    // The reason the sweep is not given a session id: a turn whose client
    // vanished leaves its segments behind, and the next turn of any session is
    // what reclaims them. Here the aged-out file belongs to another session.
    const other = "1f360c47-deca-4d9a-8a69-f501d09fa8b2";
    await mkdir(join(root, other), { recursive: true });
    await writeFile(
      join(root, other, `${other}-${storage.SEGMENT_MARKER}-0.wav`),
      Buffer.from("RIFF0000WAVEfmt ")
    );

    const removed = await storage.sweepStaleSegments(RETENTION_MS, pastTheWindow());

    assert.deepEqual(removed, [`/audio/${other}/${other}-${storage.SEGMENT_MARKER}-0.wav`]);
    assert.deepEqual(await readdir(join(root, other)), []);
  });

  it("leaves a temporary-looking file alone when its name is not a segment", async () => {
    // The marker is an allowlist, so the failure mode of getting a name wrong is
    // a stranded file rather than durable audio deleted. This pins that choice:
    // a chunk-shaped name that no route currently writes is not swept.
    const stranger = `${SESSION}-speak-chunk-0.wav`;
    await write(stranger);

    const removed = await storage.sweepStaleSegments(RETENTION_MS, pastTheWindow());

    assert.deepEqual(removed, []);
    assert.deepEqual(await remaining(), [stranger]);
  });
});

describe("the media type the mount serves a file with", () => {
  it("knows the audio containers the mount's own table does", () => {
    // The table is `mime@1.6.0`, pinned by `send` — the same one the mount resolves through, so the
    // library's answer and a client's served bytes cannot disagree.
    for (const name of ["a.mp3", "a.wav", "a.flac", "a.m4a", "a.ogg", "a.aac", "a.weba", "a.aiff", "a.wma"]) {
      assert.equal(storage.isServableAudio(name), true, `${name} is served as audio`);
    }
  });

  it("supplies the containers its table is too old to know, and only playable ones", () => {
    // `.opus` is a mainstream music container and the table, filled in 2017, answers
    // `application/octet-stream` for it. The criterion for the supplement is "the table lacks it
    // **and** a browser can play it", so a container that is neither is left out rather than offered
    // as a track that can only ever fail to play.
    assert.equal(storage.isServableAudio("a.opus"), true, "admitted from the supplement");
    assert.equal(storage.isServableAudio("a.m4b"), true, "and m4b");
    assert.equal(storage.isServableAudio("a.ape"), false, "unplayable, and so not offered");
    assert.equal(storage.isServableAudio("a.wv"), false, "nor WavPack");
  });

  it("does not offer what is not audio", () => {
    for (const name of ["Thumbs.db", "cover.jpg", "Nhac Phap.xspf", "a.webm", "a.mp4", "notes.txt"]) {
      assert.equal(storage.isServableAudio(name), false, `${name} is not a track`);
    }
  });

  it("does not offer a playlist, though its media type is audio-prefixed", () => {
    // `audio/x-mpegurl` begins `audio/`, so a prefix test alone would put a list of tracks on the
    // shelf where a track belongs. The exclusion is named rather than inferred from the prefix.
    assert.equal(storage.audioMediaType("list.m3u"), "audio/x-mpegurl", "typed as audio");
    assert.equal(storage.isServableAudio("list.m3u"), false, "and still not a track");
  });
});

describe("saveAudioFromPcm", () => {
  it("writes a WAV whose header describes the PCM the windows carried", async () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const pcmPath = join(root, "turn-0001.pcm");
    await writeFile(pcmPath, pcm);

    const { filePath, urlPath } = await storage.saveAudioFromPcm(
      SESSION,
      pcmPath,
      pcm.length,
      "candidate"
    );

    assert.match(urlPath, /^\/audio\/[0-9a-f-]+\/[0-9a-f-]+-candidate\.wav$/);

    const wav = await readFile(filePath);
    const parsed = parseWav(wav);

    assert.deepEqual(parsed.fmt, {
      audioFormat: 1,
      numChannels: 1,
      sampleRate: 16_000,
      byteRate: 32_000,
      blockAlign: 2,
      bitsPerSample: 16,
    });
    assert.equal(parsed.pcmLength, pcm.length, "the header states the length the answer ended up having");
    assert.deepEqual(
      [...wav.subarray(parsed.pcmOffset, parsed.pcmOffset + parsed.pcmLength)],
      [...pcm],
      "and the bytes behind it are the windows' PCM, in order"
    );
  });
});

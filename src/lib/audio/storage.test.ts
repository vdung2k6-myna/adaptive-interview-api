import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

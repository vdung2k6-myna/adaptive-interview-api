/**
 * The tracks this deployment can be asked to play.
 *
 * A library is a directory of files, read when it is asked rather than at boot: a track dropped in
 * while the platform runs is playable, and a directory that is not there is "no music" rather than
 * a platform that will not start. Both are the reading a service takes of any directory it is told
 * to look at — the same one the bridge takes of its own.
 *
 * **What this module does not do is match.** It answers with the tracks in the order it reads them,
 * which is the shelf a caller numbers and a model chooses a position on; nothing here folds, scores a
 * run of words, or asks which of several files a request covers. The model is given the shelf and
 * chooses from it, which is the part that repairs a title the transcriber heard wrongly and the part
 * no comparison of strings can. A second matcher here would be a worse copy of the bridge's, for a
 * turn that already has a model in it.
 *
 * **What counts as a track is the mount's answer, not a file extension.** A file is a track when the
 * audio mount would serve it as audio — one table, shared with the mount itself, so the shelf a model
 * is offered and the bytes a client fetches cannot disagree. That admits every audio container a
 * deployment keeps, which is the point: a library of `.flac` is a library, and it was not one while
 * this asked whether a name ended in `.mp3`.
 */

import { readdir, stat } from "fs/promises";
import { basename, join, resolve } from "path";

import { AUDIO_ROOT, isServableAudio, urlPathForFile } from "@/lib/audio/storage";

/** One track, as the model is offered it and as a client fetches it. */
export interface Track {
  /** The name the library holds the track under — the file's own name, without its extension. No
   *  name is invented here: what a deployment's files are called is the deployment's to decide. */
  title: string;
  /** The path under the audio mount a client fetches it from. */
  url: string;
}

export type Library = { ok: true; tracks: readonly Track[] } | { ok: false; detail: string };

/** How many tracks a search answers with when the caller names no limit. */
export const SEARCH_LIMIT = 20;

/**
 * Fold a title, a folder or a query to one form for matching: case, accents and the
 * Vietnamese đ are differences in spelling rather than in the track.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d");
}

/** What a search answered: the tracks to offer, and how many matched before the limit. */
export interface SearchResult {
  matches: readonly Track[];
  total: number;
}

/**
 * The tracks whose title or folder contains every word of `query`.
 *
 * The folder is part of the haystack because that is how a deployment files its music: a person
 * asking for "guitar" is asking about a folder, not a word in the file's name. Every word must
 * appear rather than the whole query as one run — "ballade adeline" is how a person asks for
 * "BALLADE POUR ADELINE", and a contiguous comparison would miss it.
 *
 * The reading of the directory is unchanged: this selects from tracks already read, and the model
 * still chooses one of them.
 */
export function searchTracks(
  tracks: readonly Track[],
  query: string,
  limit = SEARCH_LIMIT
): SearchResult {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return { matches: [], total: 0 };

  const matches = tracks.filter((track) => {
    let haystack = track.title;
    try {
      haystack = `${track.title} ${decodeURIComponent(track.url)}`;
    } catch {
      // A URL that cannot be decoded is still searchable by its title.
    }
    const folded = foldForSearch(haystack);
    return words.every((word) => folded.includes(word));
  });

  return { matches: matches.slice(0, limit), total: matches.length };
}

/**
 * Every track the configured directory holds, in the order the filesystem gives them.
 *
 * Walked to any depth, because a person's music is filed in folders and reading only the top one
 * would make a track that exists a track the platform is silent about. A symbolic link is not
 * followed — `Dirent.isDirectory()` is false for one — so a folder that links back onto itself is
 * a folder this walk does not enter.
 *
 * A directory that cannot be read is a report and not a throw: it is the same thing to a caller as
 * a directory that is not there, which is that there is no music, and the reason travels with it.
 */
export async function readLibrary(directory: string): Promise<Library> {
  if (directory === "") return { ok: false, detail: "this deployment has no music library" };

  // The audio root holds every session's recordings as well as any music, and a session's recording
  // is audio — a candidate's answer is written as `.wav`. So a library pointed at the root would walk
  // into those directories and offer a person's own voice as a numbered track, to the model and to
  // any client that asks. Refused on the same terms as a directory outside the root, and complete
  // rather than a guess at directory names: sessions are only ever written directly beneath the root,
  // so a library can hold one only if it *is* the root.
  if (resolve(directory) === resolve(AUDIO_ROOT)) {
    return {
      ok: false,
      detail:
        `${directory} is the audio root, which holds every session's recordings as well as any ` +
        `music. Point MUSIC_LIBRARY_DIR at a directory inside it.`,
    };
  }

  let files: string[];
  try {
    files = await listFiles(directory);
  } catch (error) {
    return {
      ok: false,
      detail: `${directory} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const tracks: Track[] = [];
  for (const file of files.filter((name) => isServableAudio(name))) {
    const url = urlPathForFile(join(directory, file));
    if (url === null) {
      // Nothing serves it, so offering it would be offering a name that plays silence. Reported
      // rather than skipped silently: the cause is the configured directory, not this file.
      return {
        ok: false,
        detail:
          `${directory} is not inside the audio root, so a track in it has no URL a client could ` +
          `fetch. Point MUSIC_LIBRARY_DIR at a directory under AUDIO_STORAGE_DIR.`,
      };
    }
    tracks.push({ title: basename(file).replace(/\.[^.]+$/, ""), url });
  }
  return { ok: true, tracks };
}

/** Every file under `directory`, as a path relative to it, this directory's own and every
 *  directory below it. */
async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const here = prefix === "" ? directory : join(directory, prefix);
  const entries = await readdir(here, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** Whether a configured library directory is a directory at all, for the boot report. `null` when
 *  there is nothing to report — no library configured, or one that is there. */
export async function libraryComplaint(directory: string): Promise<string | null> {
  if (directory === "") return null;
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) return `${directory} is not a directory`;
  } catch {
    return `${directory} is not there`;
  }
  const library = await readLibrary(directory);
  return library.ok ? null : library.detail;
}

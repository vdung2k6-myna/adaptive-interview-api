/**
 * The tracks this deployment can be asked to play.
 *
 * A library is a directory of files, read when it is asked rather than at boot: a track dropped in
 * while the platform runs is playable, and a directory that is not there is "no music" rather than
 * a platform that will not start. Both are the reading a service takes of any directory it is told
 * to look at — the same one the bridge takes of its own.
 *
 * **What this module does not do is match.** It answers with the names a person would ask for the
 * tracks by, and it finds a track by one of those names; it does not fold, does not score a run of
 * words, and does not ask which of several files a request covers. The model is given the shelf and
 * chooses from it, which is the part that repairs a title the transcriber heard wrongly and the
 * part no comparison of strings can. A second matcher here would be a worse copy of the bridge's,
 * for a turn that already has a model in it.
 */

import { readdir, stat } from "fs/promises";
import { basename, join } from "path";

import { urlPathForFile } from "@/lib/audio/storage";

/** One track, as the model is offered it and as a client fetches it. */
export interface Track {
  /** The name a person would ask for it by — the file's own name, without its extension. */
  title: string;
  /** The path under the audio mount a client fetches it from. */
  url: string;
}

export type Library = { ok: true; tracks: readonly Track[] } | { ok: false; detail: string };

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
  for (const file of files.filter((name) => name.toLowerCase().endsWith(".mp3"))) {
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

/**
 * The track a name asks for, or the reason there is none.
 *
 * The name is one the library itself reported, so this is not a search: it compares the name as
 * given, and then — because a model may echo a name back with different capitalisation, which is
 * the same name and not a different one — without regard to case or surrounding space. Nothing
 * else is compared, and a name that two tracks answer to is reported rather than settled.
 */
export function trackNamed(
  library: Library,
  name: string
): { ok: true; track: Track } | { ok: false; detail: string } {
  if (!library.ok) return { ok: false, detail: library.detail };

  const wanted = name.trim();
  if (wanted === "") {
    return { ok: false, detail: "no track was named, and this library asks which one" };
  }

  const exact = library.tracks.filter((track) => track.title === wanted);
  const folded =
    exact.length > 0
      ? exact
      : library.tracks.filter((track) => track.title.toLowerCase() === wanted.toLowerCase());

  if (folded.length === 1) return { ok: true, track: folded[0]! };
  if (folded.length > 1) {
    return {
      ok: false,
      detail: `${folded.length} tracks are called ${wanted}: ${folded.map((t) => t.title).join(", ")}`,
    };
  }
  return { ok: false, detail: `the library holds no track called ${wanted}` };
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

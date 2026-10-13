import { Router } from "express";

import config from "@/lib/config";
import { readLibrary, type Track } from "@/lib/music";

/**
 * The deployment's music library, as a person's own client reads it.
 *
 * One read, no writes. What a deployment can play is a directory this service walks, and the model is
 * already offered it as a numbered shelf; this answers the *same* reading to the client, so the list a
 * person sees is the shelf the model chooses from — the same tracks in the same order, read the same
 * way. There is one library module and one reading of it, deliberately: two would be two answers to
 * "what is there".
 *
 * **The tracks are answered with the name and the URL, and no numbers.** A position is a handle for a
 * reasoner that will not reproduce a string faithfully, which is why the model is given one; a client
 * reproduces a string exactly, and plays by the URL it was shown — the same handle the `music` event
 * carries and the same queue already takes. So nothing here decides anything: the client asks what
 * there is, and is answered with the library.
 *
 * **What it does not do is refuse.** A deployment with no library, one whose directory cannot be read,
 * and one whose directory holds nothing this service can serve all answer that there is nothing to
 * play, and say why — which is a different answer from a shelf that happens to be empty. `readLibrary`
 * reports rather than throws, so there is no error path here to catch: an unreadable directory is a
 * report, not a 500. The credential is the `/api` mount's own; see `app.ts`.
 */

/**
 * What this route needs from outside itself.
 *
 * The directory is injected so the route's tests read a directory they made rather than a deployment's
 * — the same shape the voice-agent router takes for the same library, and the reason this is a factory
 * rather than a bare router.
 */
export interface MusicDeps {
  /** Where this deployment's library is, or empty for one that has none. */
  libraryDir: string;
}

/** What a client is told. `report` says why there is nothing to play, and is `null` where there is. */
export interface LibraryAnswer {
  tracks: readonly Track[];
  report: string | null;
}

export function createMusicRouter(overrides: Partial<MusicDeps> = {}): Router {
  const deps: MusicDeps = { libraryDir: config.music.libraryDir, ...overrides };
  const router = Router();

  router.get("/", async (_req, res) => {
    const library = await readLibrary(deps.libraryDir);

    if (!library.ok) {
      res.json({ tracks: [], report: library.detail } satisfies LibraryAnswer);
      return;
    }

    if (library.tracks.length === 0) {
      // Nothing to number is not a shelf: an empty list reads as an answer, and a person asking what
      // there is is owed the truth that there is nothing.
      res.json({
        tracks: [],
        report: `${deps.libraryDir} holds no track this service can serve`,
      } satisfies LibraryAnswer);
      return;
    }

    res.json({ tracks: library.tracks, report: null } satisfies LibraryAnswer);
  });

  return router;
}

export default createMusicRouter();

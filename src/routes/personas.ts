import { Router } from "express";
import { asc } from "drizzle-orm";

import { db } from "@/lib/db";
import { personas } from "@/lib/schema";
import { toCatalog, type CatalogEntry, type PersonaRow } from "@/lib/personas";

/**
 * The persona catalog.
 *
 * One read, no writes: the catalog is seeded by its migration and the spec says
 * it can only be changed by one, so this router has a single route on purpose.
 * A write route later adds routes here rather than reshaping this read.
 */

/**
 * What the route needs from outside itself.
 *
 * The lister is injected so the route's tests need no database — the same shape
 * the voice-agent router uses, and the reason this is a factory rather than a
 * bare router. No test in this repository reaches a database, and this route
 * would otherwise be the first that had to.
 */
export interface PersonasDeps {
  listPersonas: () => Promise<PersonaRow[]>;
}

/**
 * The stored catalog.
 *
 * Ordered in the query as well as in `toCatalog`, which is not redundant in the
 * way it looks: this is the order the rows are *read* in, and reading them in
 * the order they will be reported in is what makes an operator's `EXPLAIN` or a
 * logged query agree with the response.
 */
async function listPersonasFromDb(): Promise<PersonaRow[]> {
  return db
    .select()
    .from(personas)
    .orderBy(asc(personas.sortOrder), asc(personas.id));
}

export function createPersonasRouter(overrides: Partial<PersonasDeps> = {}): Router {
  const deps: PersonasDeps = { listPersonas: listPersonasFromDb, ...overrides };
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const entries: CatalogEntry[] = toCatalog(await deps.listPersonas());
      res.json(entries);
    } catch (err) {
      console.error("GET /api/personas error:", err);
      res.status(500).json({ error: "Failed to load personas" });
    }
  });

  return router;
}

export default createPersonasRouter();

import { Router } from "express";

import config from "@/lib/config";
import { publicProviderProfiles, type PublicProviderProfile } from "@/lib/providers";

/**
 * The provider catalog a browser chooses from.
 *
 * One read, no writes: the catalog is deployment configuration read at boot, and
 * the spec says the operator owns it, not a browser user. A write route later
 * adds routes here rather than reshaping this read.
 */

/**
 * What the route needs from outside itself.
 *
 * The lister is injected so the route's tests need no environment — the same
 * shape the persona catalog uses, and the reason this is a factory rather than a
 * bare router.
 */
export interface ProvidersDeps {
  listProviders: () => PublicProviderProfile[];
}

export function createProvidersRouter(
  deps: ProvidersDeps = {
    listProviders: () => publicProviderProfiles(config.providers.catalog),
  }
): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ profiles: deps.listProviders() });
  });

  return router;
}

export const providersRoutes = createProvidersRouter();

export default providersRoutes;

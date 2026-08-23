/**
 * API authentication utilities.
 *
 * Strategy: single shared secret via `Authorization: Bearer <token>`.
 * If `API_AUTH_TOKEN` is not set, auth is disabled (backward compatible
 * for local development).
 */

interface AuthRequestLike {
  headers: {
    get?(name: string): string | null;
    [key: string]: unknown;
  };
}

function getAuthHeader(req: AuthRequestLike): string | undefined {
  const h = req.headers;
  if (typeof h.get === "function") {
    return h.get("authorization") || undefined;
  }
  // Express-style headers
  const raw = h["authorization"] || h["Authorization"];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Validate the Authorization header against the configured API token.
 * Works with both Web Request (Next.js) and Express Request objects.
 * @param request The incoming request object.
 * @returns `true` if authorized or auth is disabled.
 */
export function validateApiAuth(request: AuthRequestLike): boolean {
  const token = process.env.API_AUTH_TOKEN;
  if (!token) {
    return true; // auth disabled
  }

  const authHeader = getAuthHeader(request);
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  return authHeader.slice(7) === token;
}

/**
 * Same as validateApiAuth but for NextRequest (identical interface).
 */
export function validateApiAuthNext(req: AuthRequestLike): boolean {
  return validateApiAuth(req);
}

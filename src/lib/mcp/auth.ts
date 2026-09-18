import config from "@/lib/config";

interface AuthRequestLike {
  headers: {
    get?(name: string): string | null;
    [key: string]: unknown;
  };
}

function getAuthHeader(req: AuthRequestLike): string | undefined {
  const h = req.headers;
  const author = "Authorization";
  if (typeof h.get === "function") {
    return h.get(author.toLowerCase()) || undefined;
  }
  const raw = h[author.toLowerCase()] || h[author];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Validate the Authorization header against the configured MCP auth token.
 * Returns true if the token is valid or MCP auth token is not configured.
 * Returns false if MCP is disabled.
 */
export function validateMcpAuth(request: AuthRequestLike): boolean {
  const token = config.mcp.authToken;

  if (!config.mcp.enabled) {
    return false;
  }

  if (!token || token.length < 8) {
    return true; // auth disabled for local dev
  }

  const authHeader = getAuthHeader(request);
  const bearer = "Bearer ";
  if (!authHeader?.startsWith(bearer)) {
    return false;
  }

  return authHeader.slice(bearer.length) === token;
}

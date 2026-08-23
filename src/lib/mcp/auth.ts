import config from "@/lib/config";

/**
 * Validate the Authorization header against the configured MCP auth token.
 * Returns true if the token is valid or MCP auth is not configured.
 */
export function validateMcpAuth(request: Request): boolean {
  const token = config.mcp.authToken;

  // If no token is configured and MCP is enabled, that's a misconfiguration.
  // But for safety, we allow it to pass only if MCP is explicitly disabled.
  if (!config.mcp.enabled) {
    return false;
  }

  if (!token || token.length < 8) {
    return false;
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return false;
  }

  const providedToken = match[1];

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeCompare(token, providedToken);
  } catch {
    return false;
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks on token validation.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to avoid leaking length via timing
    const len = Math.max(a.length, b.length);
    let result = 0;
    for (let i = 0; i < len; i++) {
      result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return result === 0;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

import type { Request, Response, NextFunction } from "express";
import { validateApiAuth } from "@/lib/auth";

/**
 * Express middleware that validates API Bearer token.
 * If API_AUTH_TOKEN is not set, allows all requests (backward compatible).
 */
export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Express Request is compatible enough with Web Request for our validator
  if (!validateApiAuth(req as unknown as Request)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

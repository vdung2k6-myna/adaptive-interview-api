import express from "express";
import cors from "cors";

import { apiAuthMiddleware } from "./middleware/auth";
import { errorHandler } from "./middleware/error";

import candidatesRoutes from "./routes/candidates";
import positionsRoutes from "./routes/positions";
import sessionsRoutes from "./routes/sessions";
import campaignsRoutes from "./routes/campaigns";
import messagesRoutes from "./routes/messages";
import evaluationsRoutes from "./routes/evaluations";
import voiceRoutes from "./routes/voice";
import voiceAgentRoutes from "./routes/voice-agent";
import personasRoutes from "./routes/personas";
import mcpRoutes from "./routes/mcp";

/**
 * The composition root: every mount and the order they are registered in.
 *
 * Kept as a builder rather than done at import time so the order itself is
 * testable — the whole of this file's contract is which middleware sees which
 * request, and nothing about that is observable from a module that has already
 * bound a port.
 *
 * Route order here is load-bearing: `/health` and `/audio` are registered
 * before the auth middleware, and `/api/mcp` handles its own auth, all three to
 * stay reachable without a token. Note what that does *not* mean: a public mount
 * is public for requests it answers itself, and the middleware after it answers
 * the rest. `express.static` calls `next()` when a file is absent, so a miss
 * under `/audio` reaches whatever is mounted next — which is why the auth
 * middleware below is scoped to `/api` rather than mounted bare. A bare
 * `app.use(apiAuthMiddleware)` answers a missing audio file with 401, and a
 * missing file then looks exactly like a rejected credential.
 */
export function createApp(): express.Express {
  const app = express();

  const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((s) => s.trim());
  console.log("[CORS] Allowed origins:", allowedOrigins);

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        console.log(`[CORS] Allowing origin: ${origin}`);
        return callback(null, true);
      }
      console.error(`[CORS] BLOCKED origin: ${origin}. Add it to FRONTEND_URL env var.`);
      callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  }));
  app.use(express.json());

  // Health check — must be BEFORE auth middleware
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "adaptive-interview-api" });
  });

  // Audio static files — public, served before auth. A request for a file that
  // has been removed is answered 404 by the absence of any route for it, rather
  // than by the auth middleware: the mount is the last thing that will ever
  // claim an `/audio` request, present or not.
  app.use("/audio", express.static(process.env.AUDIO_STORAGE_DIR || "/tmp/audio"));

  // MCP endpoint — handles its own auth (MCP_AUTH_TOKEN)
  app.use("/api/mcp", mcpRoutes);

  // Auth middleware (protects the API routes below). Scoped to `/api` so that
  // only the API is authenticated: the audio mount's misses, and any other path
  // outside `/api`, are answered as what they are instead of as a missing token.
  app.use("/api", apiAuthMiddleware);

  // Routes
  app.use("/api/candidates", candidatesRoutes);
  app.use("/api/positions", positionsRoutes);
  app.use("/api/sessions", sessionsRoutes);
  app.use("/api/campaigns", campaignsRoutes);
  app.use("/api/messages", messagesRoutes);
  app.use("/api/evaluations", evaluationsRoutes);
  app.use("/api/voice", voiceRoutes);
  app.use("/api/voice-agent", voiceAgentRoutes);
  app.use("/api/personas", personasRoutes);

  // Error handler
  app.use(errorHandler);

  return app;
}

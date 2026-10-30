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
import musicRoutes from "./routes/music";
import providersRoutes from "./routes/providers";
import mcpRoutes from "./routes/mcp";

import { audioMediaType } from "./lib/audio/storage";

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

  // Audio static files — **behind the same credential as the API**, at the same path.
  // That path is stored verbatim in every `messages.audio_url` row and built in one
  // place (`lib/audio/storage.ts`), so moving the mount rather than the URL means no
  // row stops resolving and no migration is owed — and, because it is the same
  // directory, the recordings already on disk are covered as well as the ones to come.
  //
  // It used to be mounted *before* auth, so that a segment swept at the end of a turn
  // would be answered as absent rather than as a rejected credential. That reason is
  // now the wrong way round, and worth saying plainly: behind the middleware, a
  // request with no credential for a path that holds nothing is refused exactly as one
  // holding a recording is, so an unauthenticated caller cannot tell which recordings
  // exist. The 404-versus-401 difference this mount was placed to preserve is a
  // difference nobody who may not read these files is entitled to.
  //
  // What that replaced: the mount was reachable from the internet by URL alone —
  // measured 2026-10-12 against this deployment, whose ingress forwards `/audio` as
  // well as `/api` — leaving every interview recording to the secrecy of two UUIDs.
  // Unguessable is not authenticated, and a URL leaks.
  app.use(
    "/audio",
    apiAuthMiddleware,
    express.static(process.env.AUDIO_STORAGE_DIR || "/tmp/audio", {
      // The mount names each file's type from the same table the music library reads
      // (`audioMediaType`), so a container the library offers is handed over as audio rather
      // than as an opaque stream. `.opus` is the case that forced it: `send` resolves
      // through `mime@1.6.0`, a table from 2017, which answers `application/octet-stream`
      // for it — and a library listing a track the mount then served opaquely is the drift
      // the licence audit recorded as M3.
      //
      // It works because `send` emits its `headers` event — this callback — *before* it sets
      // the type, and its own `type()` returns early when a Content-Type is already set. So
      // this replaces the mount's default rather than fighting it.
      setHeaders: (res, filePath) => {
        res.setHeader("Content-Type", audioMediaType(filePath));
      },
    })
  );

  // MCP endpoint — handles its own auth (MCP_AUTH_TOKEN)
  app.use("/api/mcp", mcpRoutes);

  // Auth middleware (protects the API routes below). Scoped to `/api` so that only
  // the API is authenticated: any path outside `/api`, and the MCP mount above which
  // carries its own token, are answered as what they are instead of as a missing
  // token. The audio mount above is the one exception, and it wears the middleware
  // itself rather than moving under `/api` — see there for why its path could not
  // change.
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
  app.use("/api/music", musicRoutes);
  app.use("/api/provider-profiles", providersRoutes);

  // Error handler
  app.use(errorHandler);

  return app;
}

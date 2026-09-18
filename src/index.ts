import "dotenv/config";

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
import mcpRoutes from "./routes/mcp";

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
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

// Audio static files — public, served before auth
app.use("/audio", express.static(process.env.AUDIO_STORAGE_DIR || "/tmp/audio"));

// MCP endpoint — handles its own auth (MCP_AUTH_TOKEN)
app.use("/api/mcp", mcpRoutes);

// Auth middleware (protects all routes below)
app.use(apiAuthMiddleware);

// Routes
app.use("/api/candidates", candidatesRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/sessions", sessionsRoutes);
app.use("/api/campaigns", campaignsRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/evaluations", evaluationsRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/voice-agent", voiceAgentRoutes);

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Adaptive Interview API listening on port ${PORT}`);
});

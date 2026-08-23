import { Router } from "express";
import { createMcpServer } from "@/lib/mcp/server";
import {
  ExpressSseTransport,
  registerTransport,
  getTransport,
  removeTransport,
} from "@/lib/mcp/express-transport";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const router = Router();

/**
 * GET /api/mcp
 * Establishes an SSE connection for the MCP protocol.
 */
router.get("/", async (_req, res) => {
  const transport = new ExpressSseTransport();
  transport.bind(res);

  // Register so POST handler can find it
  registerTransport(transport);

  // Connect MCP server to transport
  const server = createMcpServer();

  server.connect(transport).catch((err) => {
    console.error("MCP server connection error:", err);
    transport.close();
  });

  // Clean up transport when response closes
  res.on("close", () => {
    removeTransport(transport.sessionId);
    transport.close();
  });

  // Start transport (sends endpoint event)
  await transport.start();
});

/**
 * POST /api/mcp
 * Receives JSON-RPC messages from the client and forwards them
 * to the active SSE transport identified by the sessionId query param.
 */
router.post("/", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId" });
    return;
  }

  const transport = getTransport(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  try {
    const body = req.body as JSONRPCMessage;
    transport.receive(body);
    res.status(200).send("OK");
  } catch (err) {
    console.error("MCP POST handler error:", err);
    res.status(400).json({ error: "Invalid message" });
  }
});

export default router;

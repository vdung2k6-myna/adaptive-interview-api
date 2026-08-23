import { randomUUID } from "crypto";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * An SSE transport for MCP that works with Next.js App Router.
 * Uses a ReadableStream to send events and a callback to receive messages.
 */
export class NextJsSseTransport implements Transport {
  public readonly sessionId: string;
  public readonly endpointPath: string;

  private streamController: ReadableStreamController<Uint8Array> | null = null;
  private encoder = new TextEncoder();
  private _started = false;
  private _closed = false;

  // Callbacks set by the MCP server
  public onmessage?: (message: JSONRPCMessage, extra?: unknown) => void;
  public onclose?: () => void;
  public onerror?: (error: Error) => void;

  constructor(sessionId?: string) {
    this.sessionId = sessionId || randomUUID();
    this.endpointPath = `/api/mcp?sessionId=${encodeURIComponent(this.sessionId)}`;
  }

  /**
   * Create the SSE ReadableStream. Call this once per transport.
   */
  createStream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start: (controller) => {
        this.streamController = controller;
        this._started = true;

        // Send the endpoint event so the client knows where to POST messages
        this.sendEvent("endpoint", this.endpointPath);
      },
      cancel: () => {
        this.close();
      },
    });
  }

  /**
   * Start the transport (called by MCP server). Resolves immediately since
   * the stream is already created.
   */
  async start(): Promise<void> {
    // Stream is started in createStream()
  }

  /**
   * Send a JSON-RPC message back to the client via SSE.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this._closed || !this.streamController) {
      return;
    }
    const data = JSON.stringify(message);
    this.sendEvent("message", data);
  }

  /**
   * Receive a JSON-RPC message from the client (called by the POST handler).
   */
  receive(message: JSONRPCMessage): void {
    if (this._closed) {
      return;
    }
    try {
      this.onmessage?.(message);
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Close the transport and end the SSE stream.
   */
  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    if (this.streamController) {
      try {
        this.streamController.close();
      } catch {
        // Already closed
      }
      this.streamController = null;
    }
    this.onclose?.();
  }

  /**
   * Whether the transport has been closed.
   */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Send an SSE event with the given event name and data.
   */
  private sendEvent(event: string, data: string): void {
    if (!this.streamController || this._closed) {
      return;
    }
    const payload = `event: ${event}\ndata: ${data}\n\n`;
    this.streamController.enqueue(this.encoder.encode(payload));
  }
}

/**
 * Module-level registry of active SSE transports keyed by session ID.
 * In Next.js dev mode, this module may be reloaded, which clears the registry.
 * Production standalone mode keeps the module loaded for the process lifetime.
 */
const activeTransports = new Map<string, NextJsSseTransport>();

export function registerTransport(transport: NextJsSseTransport): void {
  activeTransports.set(transport.sessionId, transport);

  // Clean up on close
  const originalOnClose = transport.onclose;
  transport.onclose = () => {
    activeTransports.delete(transport.sessionId);
    originalOnClose?.();
  };
}

export function getTransport(sessionId: string): NextJsSseTransport | undefined {
  return activeTransports.get(sessionId);
}

export function removeTransport(sessionId: string): void {
  activeTransports.delete(sessionId);
}

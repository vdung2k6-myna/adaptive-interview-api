import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";

import config from "@/lib/config";
import { createVoiceAgentRouter } from "./voice-agent";

/**
 * One real turn through a reseller adapter, covering all three kinds at once:
 * the adapter hears the recording, the model asks for a gadget tool and is told
 * what happened, then answers in words the adapter speaks. The bridge's job —
 * transporting the chain — is not exercised here; this is the runtime's half.
 */

const SAMPLE = Buffer.alloc(44 + 3200);
SAMPLE.write("RIFF", 0, "ascii");
SAMPLE.writeUInt32LE(36 + 3200, 4);
SAMPLE.write("WAVE", 8, "ascii");
SAMPLE.write("fmt ", 12, "ascii");
SAMPLE.writeUInt32LE(16, 16);
SAMPLE.writeUInt16LE(1, 20);
SAMPLE.writeUInt16LE(1, 22);
SAMPLE.writeUInt32LE(16_000, 24);
SAMPLE.writeUInt32LE(32_000, 28);
SAMPLE.writeUInt16LE(2, 32);
SAMPLE.writeUInt16LE(16, 34);
SAMPLE.write("data", 36, "ascii");
SAMPLE.writeUInt32LE(3200, 40);

function wav(): Buffer {
  return SAMPLE;
}

let adapter: Server;
let adapterUrl: string;
const paths: string[] = [];
let llmCalls = 0;

before(async () => {
  config.audio.sttUrl = "";
  adapter = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      paths.push(path);
      if (path.endsWith("/stt/transcribe")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "turn through adapter", language: "en", confidence: 0.9 }));
        return;
      }
      if (path.endsWith("/llm/chat")) {
        llmCalls += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (llmCalls === 1) {
          res.end(
            [
              'event: tool_call\ndata: {"type":"tool_call","id":"call_1","name":"self.test","arguments":{"value":1}}',
              'event: usage\ndata: {"type":"usage","inputTokens":3,"outputTokens":1}',
              'event: done\ndata: {"type":"done","reason":"tool_calls"}',
              "",
            ].join("\n\n")
          );
        } else {
          res.end(
            [
              'event: text\ndata: {"type":"text","text":"all done."}',
              'event: usage\ndata: {"type":"usage","inputTokens":4,"outputTokens":2}',
              'event: done\ndata: {"type":"done","reason":"stop"}',
              "",
            ].join("\n\n")
          );
        }
        return;
      }
      if (path.endsWith("/tts/synthesize")) {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(wav());
        return;
      }
      res.writeHead(404).end("not found");
    });
  });
  adapter.listen(0, "127.0.0.1");
  await once(adapter, "listening");
  adapterUrl = `http://127.0.0.1:${(adapter.address() as AddressInfo).port}/v1`;
});

after(async () => {
  adapter.closeAllConnections();
  await new Promise<void>((resolve) => adapter.close(() => resolve()));
});

function candidate(kind: "llm" | "stt" | "tts", voice?: string): Record<string, unknown> {
  return {
    adapterId: `${kind}-adapter`,
    endpoint: adapterUrl,
    token: `adp_${kind}`,
    tenantId: "tenant-1",
    config: { model: `${kind}-model` },
    capabilities: { tools: kind === "llm", languages: ["en"] },
    ...(voice === undefined ? {} : { voice }),
    timeoutMs: 30_000,
  };
}

function events(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      const lines = block.split("\n");
      const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = data === "" ? {} : (JSON.parse(data) as Record<string, unknown>);
      } catch {
        parsed = { raw: data };
      }
      return { event: name, data: parsed };
    });
}

describe("a device turn through a reseller adapter", () => {
  it("carries the transcript, the tool call and the spoken reply", async () => {
    paths.length = 0;
    llmCalls = 0;

    const app = express();
    app.use(express.json());
    app.use(
      "/api/voice-agent",
      createVoiceAgentRouter({
        searchKnowledge: async () => ({ ok: true, chunks: [] }),
        libraryDir: "",
      })
    );
    const server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/voice-agent`;

    try {
      const form = new FormData();
      form.append("systemPrompt", "You are a tutor.");
      form.append("language", "english");
      form.append(
        "providerChain",
        JSON.stringify({
          stt: [candidate("stt")],
          llm: [candidate("llm")],
          tts: [candidate("tts", "vi-female-1")],
        })
      );
      form.append(
        "tools",
        JSON.stringify([
          { name: "self.test", description: "test the chain", inputSchema: { type: "object" } },
        ])
      );
      form.append(
        "audio",
        new Blob([new Uint8Array(wav())], { type: "audio/wav" }),
        "turn.wav"
      );

      const response = await fetch(`${base}/stream`, { method: "POST", body: form });
      assert.equal(response.status, 200);
      assert.ok(response.body !== null);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      let answered = false;
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        raw += decoder.decode(read.value, { stream: true });
        if (!answered && raw.includes("event: tool_call")) {
          answered = true;
          const call = events(raw).find((event) => event.event === "tool_call");
          assert.ok(call !== undefined);
          const result = await fetch(`${base}/tool-result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              turnId: call.data.turnId,
              index: call.data.index,
              ok: true,
              text: "the gadget did it",
            }),
          });
          assert.equal(result.status, 200);
        }
      }

      const seen = events(raw);
      const user = seen.find((event) => event.event === "user");
      assert.equal(user?.data.text, "turn through adapter", "the adapter heard the turn");
      assert.ok(seen.some((event) => event.event === "tool_call"), "the model's call reached the client");
      const sentence = seen.find(
        (event) => event.event === "sentence" && typeof event.data.audioData === "string"
      );
      assert.ok(sentence !== undefined, "the adapter's audio reaches the turn");
      assert.equal(seen.at(-1)?.event, "done");
      assert.equal(seen.at(-1)?.data.fullText, "all done.");

      assert.ok(paths.some((path) => path.endsWith("/stt/transcribe")));
      assert.ok(paths.some((path) => path.endsWith("/tts/synthesize")));
      assert.equal(llmCalls, 2, "a tool round and the answer after it");
      assert.ok(!raw.includes("adp_"), "no adapter token reaches the turn's stream");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AudioCppClient, AudioGatewayClient } from "./client";
import config from "@/lib/config";

/**
 * The STT client's contract for hearing nothing.
 *
 * This is the floor under the routes' no-speech guards: those are tested against
 * an injected transcriber, so without this the client itself is unverified — and
 * a client that went back to throwing on an empty transcript would turn every
 * silent turn into a reported failure again while all of those tests still passed.
 *
 * The client takes its base URL from `config` when it is constructed, so the stub
 * service below is pointed at by assigning that field rather than by an
 * environment variable read at import time — that would pin the whole module
 * graph, this file included, to whatever `.env` held when it was loaded.
 */
describe("AudioCppClient.transcribe", () => {
  let server: Server;
  let client: AudioCppClient;
  let audioPath: string;
  let dir: string;

  /** What the stub STT service answers the next request with. Each test sets it
   * before calling, so the file needs one server rather than one per test. */
  let respond: (res: ServerResponse) => void = () => {};
  /** Every request the stub saw: the audio client's side of the wire, which is
   * itself part of the contract. */
  const requests: { method: string; url: string; body: Buffer; authorization?: string }[] = [];

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body: Buffer.concat(chunks),
          authorization: req.headers.authorization,
        });
        respond(res);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const { port } = server.address() as AddressInfo;
    config.audio.sttUrl = `http://127.0.0.1:${port}`;
    client = new AudioCppClient();

    dir = await mkdtemp(join(tmpdir(), "stt-client-"));
    audioPath = join(dir, "turn.wav");
    await writeFile(audioPath, Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3]));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Answer with JSON and a status, the way the service does when it worked. */
  function answerJson(status: number, payload: unknown): void {
    respond = (res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
  }

  it("sends the audio to the transcriptions endpoint and returns what it heard", async () => {
    answerJson(200, { text: "I led the migration myself.", confidence: 0.87 });

    const result = await client.transcribe(audioPath);

    assert.deepEqual(result, { text: "I led the migration myself.", confidence: 0.87 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.match(requests[0].url, /\/v1\/audio\/transcriptions$/, "the route the service exposes");
    assert.match(
      requests[0].body.toString("latin1"),
      /name="file"/,
      "the audio must go as a multipart `file` field"
    );
  });

  it("sends the file's bytes as they are on disk", async () => {
    answerJson(200, { text: "heard" });

    // A marker at each end, and enough of a middle that a body assembled from a
    // truncated read would be visible. The audio is handed to fetch as a Blob over
    // the file, so this is the check that "streamed from disk" still means "all of
    // it, in order".
    const payload = Buffer.concat([
      Buffer.from("START-MARKER"),
      Buffer.alloc(64 * 1024, 0x42),
      Buffer.from("END-MARKER"),
    ]);
    await writeFile(audioPath, payload);

    await client.transcribe(audioPath);

    const body = requests.at(-1)!.body;
    assert.ok(body.includes(payload.subarray(0, 12)), "the first bytes reached the service");
    assert.ok(body.includes(payload.subarray(payload.length - 10)), "and so did the last");
  });

  it("answers an empty transcript instead of throwing — nobody spoke", async () => {
    // The reported bug: this used to throw, so a silent recording reached every
    // caller looking exactly like a dead STT service, and each reported a failed
    // transcription to someone who had simply not spoken.
    answerJson(200, { text: "", confidence: 0.2 });

    const result = await client.transcribe(audioPath);

    assert.equal(result.text, "", "an empty transcript is the answer, not an error");
    assert.equal(result.confidence, 0.2, "the confidence the service did report still comes through");
  });

  it("answers an empty transcript when the service omits the field entirely", async () => {
    answerJson(200, {});

    const result = await client.transcribe(audioPath);

    assert.equal(result.text, "");
    assert.equal(result.confidence, undefined);
  });

  it("trims a transcript of blank air down to the nothing it is", async () => {
    // A whitespace-only transcript is the same absent answer, and every caller
    // decides on emptiness — so the trim has to happen here, before them.
    answerJson(200, { text: "  \n\t " });

    assert.equal((await client.transcribe(audioPath)).text, "");
  });

  it("still throws for a service that answered with an error", async () => {
    // The other half of the distinction the guards rest on: a service that did
    // not answer is a failure, and it must not come back as silence.
    respond = (res) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream is down");
    };

    await assert.rejects(
      () => client.transcribe(audioPath),
      /STT failed \(502\): upstream is down/,
      "a non-200 must surface as the error it is"
    );
  });

  it("sends the language it was given, so the service decodes in it rather than detecting one", async () => {
    answerJson(200, { text: "xin chào" });

    await client.transcribe(audioPath, undefined, "vi");

    const sent = requests[requests.length - 1];
    assert.ok(sent);
    assert.match(
      sent.body.toString("latin1"),
      /name="language"\r?\n\r?\nvi\r?\n/,
      "the code must go as a multipart `language` field, or the service detects one"
    );
  });

  it("sends no language field at all when the caller has none to give", async () => {
    // Detection is what a caller with no language is left with, and that request
    // has to stay exactly what it was: an empty `language` field is not the same
    // request as none, and only one of the two is the behaviour being preserved.
    answerJson(200, { text: "xin chào" });

    await client.transcribe(audioPath);

    const sent = requests[requests.length - 1];
    assert.ok(sent);
    assert.doesNotMatch(
      sent.body.toString("latin1"),
      /name="language"/,
      "no language was known, so none may be claimed on the wire"
    );
  });

  it("sends a profile's key to that profile's endpoint", async () => {
    // A profile is an endpoint of its own, and its key authorizes only that
    // endpoint: a local service gets no header at all.
    const profile = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body: Buffer.concat(chunks),
          authorization: req.headers.authorization,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "heard" }));
      });
    });
    profile.listen(0, "127.0.0.1");
    await once(profile, "listening");
    const { port } = profile.address() as AddressInfo;
    try {
      const result = await client.transcribe(audioPath, undefined, "vi", {
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "sk-test",
      });
      assert.equal(result.text, "heard");
    } finally {
      profile.closeAllConnections();
      await new Promise<void>((resolve) => profile.close(() => resolve()));
    }

    const sent = requests.at(-1);
    assert.ok(sent);
    assert.equal(sent.url, "/v1/audio/transcriptions");
    assert.equal(sent.authorization, "Bearer sk-test");
    assert.equal(requests[0].authorization, undefined, "the deployment's own service needs no key");
  });
});

/**
 * The request this client makes, as one OpenAI-shaped call.
 *
 * A deployment turn names its engine in `model` and asks the gateway; a turn
 * with a provider profile names that profile's endpoint, model and key. Both
 * end at the same contract, and the answer has to be WAV because the bridge
 * reads nothing else.
 */
describe("AudioGatewayClient.synthesize", () => {
  const ORIGINAL_ENGINE = config.audio.defaultEngine;

  let gateway: Server;
  let client: AudioGatewayClient;
  /** What the stub gateway answers with, per test. */
  let reply: Buffer;
  /** Every request the stubs saw, in order. */
  const requests: {
    url: string;
    authorization?: string;
    body: Record<string, unknown>;
  }[] = [];

  function record(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(reply);
    });
  }

  before(async () => {
    gateway = createServer(record);
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");

    const { port } = gateway.address() as AddressInfo;
    config.audio.gatewayUrl = `http://127.0.0.1:${port}`;
    client = new AudioGatewayClient();
  });

  after(async () => {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    config.audio.defaultEngine = ORIGINAL_ENGINE;
  });

  /** The smallest thing the client accepts as a WAV answer. */
  function wav(): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(0, 40);
    return header;
  }

  it("asks the deployment gateway for its engine as the model", async () => {
    reply = wav();

    await client.synthesize("xin chào", { engine: "kokoro", voice: "example_voice" });

    const sent = requests.at(-1);
    assert.ok(sent);
    assert.equal(sent.url, "/v1/audio/speech");
    assert.deepEqual(sent.body, {
      model: "kokoro",
      input: "xin chào",
      voice: "example_voice",
      response_format: "wav",
    });
    assert.equal(sent.authorization, undefined, "the deployment's own gateway needs no key");
  });

  it("calls a profile's endpoint with its model and key", async () => {
    reply = wav();
    const profile = createServer(record);
    profile.listen(0, "127.0.0.1");
    await once(profile, "listening");
    const { port } = profile.address() as AddressInfo;
    try {
      await client.synthesize("xin chào", {
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "sk-test",
        model: "tts-1",
        voice: "alloy",
      });
    } finally {
      profile.closeAllConnections();
      await new Promise<void>((resolve) => profile.close(() => resolve()));
    }

    const sent = requests.at(-1);
    assert.ok(sent);
    assert.equal(sent.url, "/v1/audio/speech");
    assert.deepEqual(sent.body, {
      model: "tts-1",
      input: "xin chào",
      voice: "alloy",
      response_format: "wav",
    });
    assert.equal(sent.authorization, "Bearer sk-test");
  });

  it("refuses an answer that is not WAV", async () => {
    reply = Buffer.from('{"error":"no audio"}');

    await assert.rejects(
      () => client.synthesize("xin chào", { engine: "kokoro", voice: "example_voice" }),
      /not WAV/
    );
  });

  it("names a deployment with no synthesis service instead of fetching a relative path", async () => {
    const previous = config.audio.gatewayUrl;
    const previousEngine = config.audio.defaultEngine;
    config.audio.gatewayUrl = "";
    config.audio.defaultEngine = undefined;
    try {
      const bare = new AudioGatewayClient();
      await assert.rejects(
        () => bare.synthesize("xin chào", { engine: "kokoro", voice: "example_voice" }),
        /no synthesis service is configured/
      );
    } finally {
      config.audio.gatewayUrl = previous;
      config.audio.defaultEngine = previousEngine;
    }
  });

  it("names a deployment with no transcription service instead of fetching a relative path", async () => {
    const previous = config.audio.sttUrl;
    config.audio.sttUrl = "";
    const dir = await mkdtemp(join(tmpdir(), "stt-bare-"));
    const path = join(dir, "turn.wav");
    await writeFile(path, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    try {
      const bare = new AudioCppClient();
      await assert.rejects(
        () => bare.transcribe(path),
        /no transcription service is configured/
      );
    } finally {
      config.audio.sttUrl = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

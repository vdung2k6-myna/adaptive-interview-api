import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AudioCppClient, AudioGatewayClient } from "./client";
import { parseWav } from "./wav-utils";
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
  const requests: { method: string; url: string; body: Buffer }[] = [];

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body: Buffer.concat(chunks),
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
});

/**
 * The per-engine volume, at the one place the whole system's audio comes through.
 *
 * The gateway has no volume parameter — it forwards `text`, `voice` and `model`
 * and nothing else — so the levelling happens on the PCM it returned, here. That
 * makes this the only place a test can pin the wiring: which engine selects which
 * volume, and that a volume set above an engine's headroom is reported rather
 * than passed off as a volume that worked.
 */
describe("AudioGatewayClient.synthesize", () => {
  /** The volume map and default engine the config shipped with, so each test can
   * put them back rather than leaving the next one to inherit its setup. */
  const ORIGINAL_VOLUME = { ...config.audio.volume };
  const ORIGINAL_ENGINE = config.audio.defaultEngine;

  let gateway: Server;
  let client: AudioGatewayClient;
  /** What the stub gateway answers with, per test. */
  let reply: Buffer;
  /** Every request body the stub saw, in order. */
  const payloads: { text?: string; engine?: string; voice?: string }[] = [];

  before(async () => {
    gateway = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(reply);
      });
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");

    const { port } = gateway.address() as AddressInfo;
    config.audio.gatewayUrl = `http://127.0.0.1:${port}`;
    client = new AudioGatewayClient();
  });

  after(async () => {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    Object.assign(config.audio.volume, ORIGINAL_VOLUME);
    config.audio.defaultEngine = ORIGINAL_ENGINE;
  });

  /** A 16-bit mono WAV of the given samples, as the gateway would return. */
  function wav(samples: number[]): Buffer {
    const header = Buffer.alloc(44);
    const pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => pcm.writeInt16LE(sample, i * 2));
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
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
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  function samplesOf(buffer: Buffer, count: number): number[] {
    const { pcmOffset } = parseWav(buffer);
    return Array.from({ length: count }, (_, i) => buffer.readInt16LE(pcmOffset + i * 2));
  }

  it("levels the reply by the volume of the engine it asked for", async () => {
    reply = wav([1000, -2000, 3000]);
    config.audio.volume.kokoro = 0.5;

    const buffer = await client.synthesize("xin chào", { engine: "kokoro", voice: "diem_trinh" });

    assert.equal(payloads.at(-1)?.engine, "kokoro");
    assert.deepEqual(samplesOf(buffer, 3), [500, -1000, 1500]);
  });

  it("levels by the default engine's volume when the caller names no engine", async () => {
    // The volume and the request have to be read from the same resolved engine,
    // or audio is asked for from one engine and levelled as if it were another.
    reply = wav([1000, -2000]);
    config.audio.defaultEngine = "piper";
    config.audio.volume.piper = 0.7;

    const buffer = await client.synthesize("xin chào", { voice: "vi_VN-vais1000-medium" });

    assert.equal(payloads.at(-1)?.engine, "piper");
    assert.deepEqual(samplesOf(buffer, 2), [700, -1400]);
  });

  it("clamps what a volume set too high cannot fit, and reports it", async () => {
    // Kokoro and piper arrive at full scale, so a volume above 1 clips them. A
    // clamped sample is distortion, and distortion nobody is told about is the
    // failure this feature is meant to remove.
    reply = wav([30000, -30000, 1000]);
    config.audio.volume.piper = 2;
    const warn = mock.method(console, "warn", () => {});
    try {
      const buffer = await client.synthesize("xin chào", {
        engine: "piper",
        voice: "vi_VN-vais1000-medium",
      });

      assert.deepEqual(samplesOf(buffer, 3), [32767, -32768, 2000]);
      assert.equal(warn.mock.calls.length, 1, "the clipping must be reported exactly once");
      assert.match(String(warn.mock.calls[0]?.arguments[0]), /clipped 2\/3 samples/);
      assert.match(String(warn.mock.calls[0]?.arguments[0]), /PIPER_VOLUME/);
    } finally {
      mock.restoreAll();
    }
  });

  it("says nothing when nothing clipped", async () => {
    reply = wav([1000, -2000]);
    config.audio.volume.kokoro = 1.2;
    const warn = mock.method(console, "warn", () => {});
    try {
      const buffer = await client.synthesize("xin chào", { engine: "kokoro", voice: "diem_trinh" });

      assert.deepEqual(samplesOf(buffer, 2), [1200, -2400]);
      assert.equal(warn.mock.calls.length, 0, "a volume with headroom is not a problem to report");
    } finally {
      mock.restoreAll();
    }
  });
});

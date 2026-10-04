import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AudioCppClient } from "./client";
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

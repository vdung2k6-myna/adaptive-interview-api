import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { VoiceConversionClient } from "./client";
import { ensureVoiceConversionModel } from "./voice-catalog";

/** A buffer that carries the RIFF/WAVE header the client requires. */
function wav(marker = ""): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WAVE"),
    Buffer.from(marker, "latin1"),
  ]);
}

/**
 * The conversion client's contract with the service: the shape of the request
 * (the multipart `file` part its own `/api/convert/` declares) and the shape of
 * the answer (WAV, or a refusal).
 *
 * The client takes its base URL from `config` unless one is passed, so the stub
 * service below is injected through the constructor rather than by assigning the
 * config field: the field is read when the client is built, and a test that
 * assigned it after construction would be testing a different client.
 */
describe("VoiceConversionClient.convert", () => {
  let server: Server;
  let baseUrl: string;

  /** What the stub answers the next request with. Each test sets it before
   * calling, so the file needs one server rather than one per test. */
  let respond: (res: ServerResponse) => void = () => {};
  /** Every request the stub saw, which is the client's side of the wire. */
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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function answerWav(payload: Buffer): void {
    respond = (res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(payload);
    };
  }

  it("posts the segment as the multipart `file` part and returns the converted WAV", async () => {
    const converted = wav("converted");
    answerWav(converted);

    const client = new VoiceConversionClient({ baseUrl, timeoutMs: 5_000 });
    const result = await client.convert(wav("input"));

    assert.deepEqual(result, converted, "the service's bytes are returned, not the input's");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.match(requests[0].url, /\/api\/convert\/$/, "the route the service declares");
    assert.match(
      requests[0].body.toString("latin1"),
      /name="file"/,
      "the audio must go as the `file` part the service declares"
    );
  });

  it("sends the shaping it is given, and only the parts it names", async () => {
    answerWav(wav("converted"));
    const client = new VoiceConversionClient({ baseUrl, timeoutMs: 5_000 });

    await client.convert(wav("input"), undefined, {
      pitchShift: 12,
      formantShift: -3.5,
      f0Method: "rmvpe",
    });

    const body = requests.at(-1)!.body.toString("latin1");
    assert.match(body, /name="pitch_shift"\r\n\r\n12\r\n/);
    assert.match(body, /name="formant_shift"\r\n\r\n-3\.5\r\n/);
    assert.match(body, /name="f0_method"\r\n\r\nrmvpe\r\n/);
  });

  it("omits zero shifts and an empty method, which are the service defaults", async () => {
    answerWav(wav("converted"));
    const client = new VoiceConversionClient({ baseUrl, timeoutMs: 5_000 });

    await client.convert(wav("input"), undefined, { pitchShift: 0, formantShift: 0 });

    const body = requests.at(-1)!.body.toString("latin1");
    assert.doesNotMatch(body, /name="pitch_shift"/, "zero is the service default, not a request");
    assert.doesNotMatch(body, /name="formant_shift"/);
    assert.doesNotMatch(body, /name="f0_method"/);
  });

  it("refuses an answer that is not WAV rather than delivering it", async () => {
    respond = (res) => {
      res.writeHead(200, { "Content-Type": "audio/ogg" });
      res.end(Buffer.from("OggS-not-a-wav"));
    };

    const client = new VoiceConversionClient({ baseUrl, timeoutMs: 5_000 });

    await assert.rejects(
      () => client.convert(wav("input")),
      /not WAV/,
      "the same check a synthesis answer gets is applied to the converted answer"
    );
  });

  it("reports an error answer with its status and detail", async () => {
    respond = (res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Model manager not initialized" }));
    };

    const client = new VoiceConversionClient({ baseUrl, timeoutMs: 5_000 });

    await assert.rejects(
      () => client.convert(wav("input")),
      /Voice conversion failed \(503\).*Model manager not initialized/
    );
  });

  it("names the missing service rather than attempting a relative URL", async () => {
    const client = new VoiceConversionClient({ baseUrl: "", timeoutMs: 5_000 });

    assert.equal(client.configured, false);
    await assert.rejects(() => client.convert(wav("input")), /no voice-conversion service/);
  });

  it("stops when the turn that asked for it ends", async () => {
    // Never answered: the only way this call returns is the signal the turn
    // carries, which is what the client's combined signal is for.
    respond = () => {};
    const client = new VoiceConversionClient({ baseUrl, timeoutMs: 60_000 });
    const turn = new AbortController();
    turn.abort();

    await assert.rejects(() => client.convert(wav("input"), turn.signal));
  });
});

/**
 * The startup ensure: a service that lost its active model is given it back,
 * and each way it can still be unusable is reported once at boot. None of them
 * is thrown — the audio tier is not on the API's boot path.
 */
describe("ensureVoiceConversionModel", () => {
  let server: Server;
  let baseUrl: string;

  /** What the stub reports as active, and what it answers an activation with. */
  let activeName: string | null = null;
  let activateAnswer: ((name: string, res: ServerResponse) => void) | null = null;
  const activateRequests: string[] = [];
  /** The F0 methods the active model advertises. */
  let f0Methods: string[] = ["pm", "harvest", "rmvpe"];

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";

      if (req.method === "GET" && url === "/api/models/active") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            activeName === null
              ? { active: false }
              : { active: true, name: activeName, details: { f0_methods: f0Methods } }
          )
        );
        return;
      }

      const match =
        req.method === "POST" ? url.match(/^\/api\/models\/(.+)\/activate$/) : null;
      if (match) {
        const name = decodeURIComponent(match[1]);
        activateRequests.push(name);
        if (activateAnswer) {
          activateAnswer(name, res);
          return;
        }
        // The successful case: activation is what makes this model active.
        activeName = name;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name, status: "active" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    activeName = null;
    activateAnswer = null;
    activateRequests.length = 0;
    f0Methods = ["pm", "harvest", "rmvpe"];
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(): VoiceConversionClient {
    return new VoiceConversionClient({
      baseUrl,
      timeoutMs: 2_000,
      activationTimeoutMs: 5_000,
    });
  }

  it("says nothing when the active model is the configured one", async () => {
    activeName = "voice.pth";
    assert.equal(await ensureVoiceConversionModel("voice.pth", client()), null);
    assert.deepEqual(activateRequests, [], "an already-active model is never reloaded");
  });

  it("activates the configured model when the service reports none", async () => {
    assert.equal(await ensureVoiceConversionModel("voice.pth", client()), null);
    assert.deepEqual(activateRequests, ["voice.pth"], "the restart leaves nothing active");
  });

  it("activates the configured model when a different one is active", async () => {
    activeName = "other.pth";
    assert.equal(await ensureVoiceConversionModel("voice.pth", client()), null);
    assert.deepEqual(activateRequests, ["voice.pth"]);
  });

  it("names the model in the URL-encoded activation path", async () => {
    assert.equal(await ensureVoiceConversionModel("my voice.pth", client()), null);
    assert.deepEqual(activateRequests, ["my voice.pth"]);
  });

  it("reports a service with no active model when no model is named", async () => {
    const complaint = await ensureVoiceConversionModel("", client());
    assert.match(complaint ?? "", /no active model/);
    assert.deepEqual(activateRequests, [], "there is nothing to activate without a name");
  });

  it("accepts any active model when the deployment names none", async () => {
    activeName = "whatever.pth";
    assert.equal(await ensureVoiceConversionModel("", client()), null);
    assert.deepEqual(activateRequests, []);
  });

  it("reports a model the service does not hold", async () => {
    activateAnswer = (_name, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Model not found: voice.pth" }));
    };

    const complaint = await ensureVoiceConversionModel("voice.pth", client());

    assert.match(complaint ?? "", /could not be activated/);
    assert.match(complaint ?? "", /404/);
    assert.match(complaint ?? "", /Model not found/);
  });

  it("reports an activation that did not take effect", async () => {
    activateAnswer = (_name, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "active" }));
    };

    const complaint = await ensureVoiceConversionModel("voice.pth", client());

    assert.match(complaint ?? "", /did not become active/);
    assert.match(complaint ?? "", /none/);
  });

  it("reports an unreachable service without trying to activate", async () => {
    // Nothing listens on port 1, so this is refused rather than waited on.
    const unreachable = new VoiceConversionClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 2_000,
      activationTimeoutMs: 2_000,
    });
    assert.match(
      (await ensureVoiceConversionModel("voice.pth", unreachable)) ?? "",
      /unreachable/
    );
    assert.deepEqual(activateRequests, []);
  });

  it("has nothing to report when the deployment names no service", async () => {
    const unconfigured = new VoiceConversionClient({ baseUrl: "" });
    assert.equal(await ensureVoiceConversionModel("voice.pth", unconfigured), null);
  });

  it("accepts a voice-agent F0 method the service advertises", async () => {
    activeName = "voice.pth";
    assert.equal(
      await ensureVoiceConversionModel("voice.pth", client(), "rmvpe"),
      null,
      "an advertised method is usable"
    );
  });

  it("reports a voice-agent F0 method the service does not advertise", async () => {
    activeName = "voice.pth";

    const complaint = await ensureVoiceConversionModel("voice.pth", client(), "crepe");

    assert.match(complaint ?? "", /F0 method 'crepe'/);
    assert.match(complaint ?? "", /advertises/);
    assert.match(complaint ?? "", /pm, harvest, rmvpe/, "the report names what is usable");
  });

  it("checks the F0 method after activating the configured model", async () => {
    const complaint = await ensureVoiceConversionModel("voice.pth", client(), "harvest");

    assert.equal(complaint, null, "activation restores the model and its methods are read next");
    assert.deepEqual(activateRequests, ["voice.pth"]);
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { AudioGatewayClient, VoiceConversionClient } from "./client";
import { synthesizeSpeechWithFallback } from "./text-processing";
import config from "@/lib/config";

/** A buffer that carries the RIFF/WAVE header the client requires. */
function wav(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WAVE"),
    Buffer.from(marker, "latin1"),
  ]);
}

/**
 * Where conversion sits: inside `synthesize()`, after the answer is validated,
 * so it covers both a deployment engine and a TTS profile's own endpoint.
 *
 * Every failure mode is asserted here because the two are different promises: a
 * required conversion fails the turn rather than speaking in a voice nobody
 * asked for, and an optional one delivers the unconverted answer and says so.
 */
describe("AudioGatewayClient.synthesize with voice conversion", () => {
  const ORIGINAL_GATEWAY = config.audio.gatewayUrl;
  const ORIGINAL_REQUIRED = config.audio.ovc.required;

  let gateway: Server;
  let converter: Server;
  let profile: Server;
  let gatewayUrl: string;
  let converterUrl: string;
  let profileUrl: string;

  /** What the synthesis stubs answer with. */
  let sourceReply: Buffer;
  /** What the conversion stub answers with. */
  let convertAnswer: (res: ServerResponse) => void;
  /** Every conversion request, and every synthesis request to the profile. */
  const conversions: Buffer[] = [];
  const profileRequests: string[] = [];

  before(async () => {
    sourceReply = wav("source");
    convertAnswer = (res) => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wav("converted"));
    };

    const synth = (record?: string[]) =>
      createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          record?.push(req.url ?? "");
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(sourceReply);
        });
      });
    const convert = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        conversions.push(Buffer.concat(chunks));
        convertAnswer(res);
      });
    });

    gateway = synth();
    profile = synth(profileRequests);
    converter = convert;
    for (const server of [gateway, profile, converter]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    profileUrl = `http://127.0.0.1:${(profile.address() as AddressInfo).port}`;
    converterUrl = `http://127.0.0.1:${(converter.address() as AddressInfo).port}`;

    config.audio.gatewayUrl = gatewayUrl;
  });

  after(async () => {
    for (const server of [gateway, profile, converter]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    config.audio.gatewayUrl = ORIGINAL_GATEWAY;
    config.audio.ovc.required = ORIGINAL_REQUIRED;
  });

  function client(conversionUrl: string): AudioGatewayClient {
    return new AudioGatewayClient({
      timeoutMs: 5_000,
      conversion: new VoiceConversionClient({ baseUrl: conversionUrl, timeoutMs: 5_000 }),
    });
  }

  it("converts a deployment engine's answer", async () => {
    conversions.length = 0;

    const result = await client(converterUrl).synthesize("xin chào", {
      engine: "kokoro",
      voice: "example_voice",
    });

    assert.deepEqual(result, wav("converted"), "the converted answer is what is delivered");
    assert.equal(conversions.length, 1, "the engine's answer went through the service");
    assert.ok(conversions[0].includes(sourceReply), "the service received the synthesized bytes");
  });

  it("converts a TTS profile's answer, which never reaches the gateway", async () => {
    conversions.length = 0;
    profileRequests.length = 0;

    const result = await client(converterUrl).synthesize("xin chào", {
      baseUrl: profileUrl,
      model: "tts-1",
      voice: "alloy",
    });

    assert.deepEqual(result, wav("converted"), "the profile's answer is converted too");
    assert.equal(profileRequests.length, 1, "the profile's own endpoint synthesized it");
    assert.equal(conversions.length, 1, "and the conversion service saw it");
  });

  it("carries the turn's shaping to the conversion service", async () => {
    conversions.length = 0;

    await client(converterUrl).synthesize("xin chào", {
      engine: "kokoro",
      voice: "example_voice",
      conversion: { pitchShift: 12, formantShift: 10, f0Method: "rmvpe" },
    });

    const body = conversions[0].toString("latin1");
    assert.match(body, /name="pitch_shift"\r\n\r\n12\r\n/, "the pitch shift is sent");
    assert.match(body, /name="formant_shift"\r\n\r\n10\r\n/, "the formant shift is sent");
    assert.match(body, /name="f0_method"\r\n\r\nrmvpe\r\n/, "the F0 method is sent");
  });

  it("sends no shaping parts when the turn names none", async () => {
    conversions.length = 0;

    await client(converterUrl).synthesize("xin chào", {
      engine: "kokoro",
      voice: "example_voice",
    });

    const body = conversions[0].toString("latin1");
    assert.doesNotMatch(body, /name="pitch_shift"/, "no pitch part a caller did not ask for");
    assert.doesNotMatch(body, /name="formant_shift"/, "no formant part");
    assert.doesNotMatch(body, /name="f0_method"/, "no method part");
  });

  it("carries a configured turn's shaping through the synthesis core", async () => {
    conversions.length = 0;
    const gatewayClient = client(converterUrl);

    const result = await synthesizeSpeechWithFallback(
      "Hello there.",
      {
        engine: "kokoro",
        voice: "example_voice",
        conversion: { pitchShift: 12, formantShift: 10, f0Method: "rmvpe" },
      },
      0,
      undefined,
      (text, options) => gatewayClient.synthesize(text, options)
    );

    assert.deepEqual(result, wav("converted"), "the converted answer passed the WAV check");
    const body = conversions[0].toString("latin1");
    assert.match(body, /name="pitch_shift"\r\n\r\n12\r\n/);
    assert.match(body, /name="formant_shift"\r\n\r\n10\r\n/);
    assert.match(body, /name="f0_method"\r\n\r\nrmvpe\r\n/);
  });

  it("carries only the file through the synthesis core when no shaping is named", async () => {
    conversions.length = 0;
    const gatewayClient = client(converterUrl);

    await synthesizeSpeechWithFallback(
      "Hello there.",
      { engine: "kokoro", voice: "example_voice" },
      0,
      undefined,
      (text, options) => gatewayClient.synthesize(text, options)
    );

    const body = conversions[0].toString("latin1");
    assert.match(body, /name="file"/, "the segment is still sent");
    assert.doesNotMatch(body, /name="pitch_shift"/);
    assert.doesNotMatch(body, /name="formant_shift"/);
    assert.doesNotMatch(body, /name="f0_method"/);
  });

  it("skips conversion when the turn opts out, even with a service configured", async () => {
    conversions.length = 0;

    const result = await client(converterUrl).synthesize("xin chào", {
      engine: "kokoro",
      voice: "example_voice",
      conversion: false,
    });

    assert.deepEqual(result, sourceReply, "the synthesized audio is delivered unchanged");
    assert.equal(conversions.length, 0, "no conversion request is made on the turn's behalf");
  });

  it("forwards every configured option", async () => {
    conversions.length = 0;

    await client(converterUrl).synthesize("xin chào", {
      engine: "kokoro",
      voice: "example_voice",
      conversion: {
        pitchShift: 12,
        formantShift: 10,
        f0Method: "rmvpe",
        indexRate: 0.6,
        protect: 0.4,
        rmsMixRate: 0.2,
        filterRadius: 4,
        crepeHopLength: 128,
        effects: { reverb: { enabled: true, size: 0.3 } },
      },
    });

    const body = conversions[0].toString("latin1");
    assert.match(body, /name="index_rate"\r\n\r\n0\.6\r\n/);
    assert.match(body, /name="protect"\r\n\r\n0\.4\r\n/);
    assert.match(body, /name="rms_mix_rate"\r\n\r\n0\.2\r\n/);
    assert.match(body, /name="filter_radius"\r\n\r\n4\r\n/);
    assert.match(body, /name="crepe_hop_length"\r\n\r\n128\r\n/);
    assert.match(body, /name="effects"/);
    assert.ok(body.includes('"reverb"'), "the effects chain is sent as JSON");
  });

  it("delivers the answer unchanged when the deployment names no service", async () => {
    conversions.length = 0;

    const result = await client("").synthesize("xin chào", {
      engine: "kokoro",
      voice: "example_voice",
    });

    assert.deepEqual(result, sourceReply);
    assert.equal(conversions.length, 0, "no unconfigured service is called");
  });

  it("fails the synthesis when a required conversion fails", async () => {
    config.audio.ovc.required = true;
    convertAnswer = (res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Model manager not initialized" }));
    };

    await assert.rejects(
      () =>
        client(converterUrl).synthesize("xin chào", {
          engine: "kokoro",
          voice: "example_voice",
        }),
      /Voice conversion failed \(503\).*Model manager not initialized/,
      "a required conversion reports the failure rather than speaking unconverted"
    );
  });

  it("delivers the unconverted answer when an optional conversion fails", async () => {
    config.audio.ovc.required = false;
    convertAnswer = (res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Model manager not initialized" }));
    };

    const result = await client(converterUrl).synthesize("xin chào", {
      engine: "kokoro",
      voice: "example_voice",
    });

    assert.deepEqual(result, sourceReply, "the cosmetic layer degrades to no conversion");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  defaultProviderFor,
  parseProviderCatalog,
  parseProviderDefaults,
  publicProviderProfile,
  type ProviderKind,
} from "./providers";

const CATALOG = JSON.stringify([
  {
    id: "kokoro-vi",
    kind: "tts",
    name: "Kokoro Vietnamese",
    baseUrl: "http://localhost:8082",
    model: "kokoro",
    voice: "example_voice",
  },
  {
    id: "openai-stt",
    kind: "stt",
    name: "OpenAI Whisper",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    apiKey: "sk-stt",
  },
  {
    id: "openai-llm",
    kind: "llm",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "sk-llm",
  },
]);

function defaults(overrides: Partial<Record<ProviderKind, string | null>> = {}) {
  return { llm: null, stt: null, tts: null, ...overrides };
}

describe("parseProviderCatalog", () => {
  it("reads every kind, with the voice a tts profile needs", () => {
    const catalog = parseProviderCatalog(CATALOG, "PROVIDER_CATALOG");

    assert.equal(catalog.length, 3);
    assert.deepEqual(
      catalog.map((profile) => [profile.id, profile.kind, profile.voice ?? null]),
      [
        ["kokoro-vi", "tts", "example_voice"],
        ["openai-stt", "stt", null],
        ["openai-llm", "llm", null],
      ]
    );
  });

  it("reads an absent catalog as an empty one", () => {
    assert.deepEqual(parseProviderCatalog(undefined, "PROVIDER_CATALOG"), []);
    assert.deepEqual(parseProviderCatalog("", "PROVIDER_CATALOG"), []);
  });

  it("refuses a tts profile with no voice", () => {
    const raw = JSON.stringify([
      { id: "x", kind: "tts", name: "X", baseUrl: "http://localhost:1", model: "kokoro" },
    ]);

    assert.throws(() => parseProviderCatalog(raw, "PROVIDER_CATALOG"), /voice is required/);
  });

  it("refuses a base URL that is not absolute http(s)", () => {
    const raw = JSON.stringify([
      { id: "x", kind: "stt", name: "X", baseUrl: "localhost:8080", model: "stt" },
    ]);

    assert.throws(() => parseProviderCatalog(raw, "PROVIDER_CATALOG"), /absolute http\(s\) URL/);
  });

  it("refuses an id used twice", () => {
    const raw = JSON.stringify([
      { id: "x", kind: "stt", name: "X", baseUrl: "http://localhost:1", model: "stt" },
      { id: "x", kind: "llm", name: "X", baseUrl: "http://localhost:1", model: "llm" },
    ]);

    assert.throws(() => parseProviderCatalog(raw, "PROVIDER_CATALOG"), /used twice/);
  });

  it("refuses a kind it does not know", () => {
    const raw = JSON.stringify([
      { id: "x", kind: "video", name: "X", baseUrl: "http://localhost:1", model: "x" },
    ]);

    assert.throws(() => parseProviderCatalog(raw, "PROVIDER_CATALOG"), /kind must be one of/);
  });
});

describe("publicProviderProfile", () => {
  it("reduces the key to whether one is set", () => {
    const catalog = parseProviderCatalog(CATALOG, "PROVIDER_CATALOG");

    const publicProfiles = catalog.map(publicProviderProfile);

    assert.equal(publicProfiles[0]?.hasKey, false);
    assert.equal(publicProfiles[1]?.hasKey, true);
    assert.equal(JSON.stringify(publicProfiles).includes("sk-"), false, "no key may travel");
  });
});

describe("parseProviderDefaults", () => {
  it("resolves a default that names a profile of its kind", () => {
    const catalog = parseProviderCatalog(CATALOG, "PROVIDER_CATALOG");

    const parsed = parseProviderDefaults(
      { PROVIDER_DEFAULT_TTS: "kokoro-vi" } as NodeJS.ProcessEnv,
      catalog
    );

    assert.deepEqual(parsed, defaults({ tts: "kokoro-vi" }));
  });

  it("refuses a default that names no profile", () => {
    const catalog = parseProviderCatalog(CATALOG, "PROVIDER_CATALOG");

    assert.throws(
      () =>
        parseProviderDefaults(
          { PROVIDER_DEFAULT_TTS: "missing" } as NodeJS.ProcessEnv,
          catalog
        ),
      /names no profile/
    );
  });

  it("refuses a default of another kind", () => {
    const catalog = parseProviderCatalog(CATALOG, "PROVIDER_CATALOG");

    assert.throws(
      () =>
        parseProviderDefaults(
          { PROVIDER_DEFAULT_TTS: "openai-stt" } as NodeJS.ProcessEnv,
          catalog
        ),
      /not a tts one/
    );
  });
});

describe("defaultProviderFor", () => {
  it("returns the profile a kind's default names", () => {
    const catalog = parseProviderCatalog(CATALOG, "PROVIDER_CATALOG");

    const profile = defaultProviderFor(catalog, "tts", defaults({ tts: "kokoro-vi" }));

    assert.equal(profile?.id, "kokoro-vi");
  });

  it("returns nothing when the kind has no default", () => {
    const catalog = parseProviderCatalog(CATALOG, "PROVIDER_CATALOG");

    assert.equal(defaultProviderFor(catalog, "llm", defaults()), undefined);
  });
});

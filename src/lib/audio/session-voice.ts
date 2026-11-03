/**
 * The voice an interview session is spoken in.
 *
 * A session stores the TTS profile it names, or nothing for the deployment
 * default. Sessions written before provider profiles carry an engine instead;
 * that engine is served only where the deployment still configures a synthesis
 * gateway, and otherwise fails with an error naming what is missing — never by
 * quietly choosing another engine or voice.
 */

import config from "@/lib/config";
import {
  defaultProviderFor,
  findProvider,
  type ProviderKind,
  type ProviderProfile,
} from "@/lib/providers";
import type { SynthesizeOptions } from "./client";
import { resolveEngineForLanguage, resolveVoice } from "./text-processing";

type Engine = "kokoro" | "piper" | "supertonic";
type InterviewLanguage = "english" | "vietnamese";

/** What the decision reads: the profile a session names, or its legacy engine. */
export interface SessionVoiceFields {
  ttsProfileId?: string | null;
  ttsProvider?: string | null;
}

export interface SessionVoiceDeps {
  catalog: readonly ProviderProfile[];
  defaults: Readonly<Record<ProviderKind, string | null>>;
  gatewayUrl: string;
  defaultEngine?: Engine;
  defaultVoice: string;
}

export type SessionVoiceResolution = { options: SynthesizeOptions } | { error: string };

/**
 * The deployment's settings, read per call: the catalog and the audio addresses
 * are configuration, and a caller (a test, or a deployment that reloads its
 * catalog) may change them after this module is loaded.
 */
function deployment(): SessionVoiceDeps {
  return {
    catalog: config.providers.catalog,
    defaults: config.providers.defaults,
    gatewayUrl: config.audio.gatewayUrl,
    defaultEngine: config.audio.defaultEngine,
    defaultVoice: config.audio.defaultVoice,
  };
}

function profileOptions(profile: ProviderProfile, defaultVoice: string): SynthesizeOptions {
  return {
    baseUrl: profile.baseUrl,
    model: profile.model,
    voice: profile.voice ?? defaultVoice,
    ...(profile.apiKey === undefined || profile.apiKey === ""
      ? {}
      : { apiKey: profile.apiKey }),
  };
}

/**
 * Resolve a session's synthesis: its profile, then its legacy engine where a
 * gateway is configured, then the deployment default.
 */
export function resolveSessionVoice(
  session: SessionVoiceFields,
  language: InterviewLanguage,
  deps: SessionVoiceDeps = deployment()
): SessionVoiceResolution {
  const profileId = (session.ttsProfileId ?? "").trim();
  if (profileId !== "") {
    const profile = findProvider(deps.catalog, profileId);
    if (profile === undefined || profile.kind !== "tts") {
      return {
        error: `the session's text-to-speech profile "${profileId}" is not configured`,
      };
    }
    return { options: profileOptions(profile, deps.defaultVoice) };
  }

  const engine = (session.ttsProvider ?? "").trim();
  if (engine !== "") {
    if (deps.gatewayUrl === "") {
      return {
        error: `this session was recorded with the "${engine}" engine, and no synthesis gateway is configured`,
      };
    }
    const resolved = resolveEngineForLanguage(engine as Engine, language);
    if (resolved !== undefined) {
      return { options: { engine: resolved, voice: resolveVoice(resolved, language) } };
    }
    return { error: "no text-to-speech engine is configured for this session" };
  }

  const fallback = defaultProviderFor(deps.catalog, "tts", deps.defaults);
  if (fallback !== undefined) {
    return { options: profileOptions(fallback, deps.defaultVoice) };
  }

  if (deps.defaultEngine !== undefined && deps.gatewayUrl !== "") {
    const resolved = resolveEngineForLanguage(deps.defaultEngine, language);
    if (resolved !== undefined) {
      return { options: { engine: resolved, voice: resolveVoice(resolved, language) } };
    }
  }

  return { error: "no text-to-speech provider is configured for this deployment" };
}

/**
 * Voice catalog: which Supertonic voices this deployment asks for, and whether
 * the synthesis service actually holds them.
 *
 * The service's style directory is the catalog — a style file named `me.json`
 * is the voice `me` — so a name that holds no style file is a misconfiguration
 * rather than a fallback. The comparison is made here, once, from the voices
 * the gateway relays, because the alternative is discovering it on the first
 * turn that speaks in the wrong voice.
 */

import config from "@/lib/config";
import { audioGateway, voiceConversion, type VoiceConversionClient } from "./client";

/** The engines a voice name can be resolved for. */
type Engine = "kokoro" | "piper" | "supertonic";

/**
 * Every voice name `resolveVoice` can return for the supertonic engine.
 *
 * Mirrors that function's own fallback: a configured name that is empty
 * resolves to the default voice, and the default voice is itself reachable
 * whenever the default engine is supertonic.
 */
export function configuredSupertonicVoices(
  voices: { english: string; vietnamese: string },
  options: { defaultEngine: Engine | undefined; defaultVoice: string }
): string[] {
  const configured = [voices.english, voices.vietnamese].map((name) =>
    (name ?? "").trim()
  );
  const resolved = configured.map(
    (name) => name || options.defaultVoice.trim()
  );
  if (options.defaultEngine === "supertonic") {
    resolved.push(options.defaultVoice.trim());
  }
  return [...new Set(resolved)].filter((name) => name.length > 0);
}

/** The names in `names` the service does not hold. */
export function unavailableVoices(names: string[], held: string[]): string[] {
  const available = new Set(held);
  return names.filter((name) => !available.has(name));
}

/**
 * Make the voice-conversion service speak in the model this deployment names,
 * or say why it cannot.
 *
 * The service keeps the active model in memory only, so every restart of the
 * service — not of this API — leaves it with none, and `/api/convert/` then
 * answers 200 with the input essentially unchanged. A required deployment
 * cannot observe that, so the runtime activates the configured model at boot
 * when the service reports no active model or a different one.
 *
 * Reported rather than thrown, and returned rather than logged, so the boot path
 * can decide how to say it and a test can assert it without a real service.
 * Each case is distinct — unreachable, no model named to activate, activation
 * refused, activation not taking effect, an F0 method the active model does not
 * advertise — because each needs a different fix. A deployment that names no
 * service has nothing to report; one that names a service but no model can only
 * be reported, not repaired.
 */
export async function ensureVoiceConversionModel(
  expectedModel: string,
  client: VoiceConversionClient = voiceConversion,
  expectedF0Method = ""
): Promise<string | null> {
  if (!client.configured) return null;

  let status = await client.status();
  if (!status.reachable) {
    return "the configured voice-conversion service is unreachable";
  }

  if (expectedModel === "") {
    if (status.activeModel === null) {
      return "the voice-conversion service reports no active model and OVC_MODEL names none to activate";
    }
  } else if (status.activeModel !== expectedModel) {
    try {
      await client.activate(expectedModel);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `the configured conversion model '${expectedModel}' could not be activated: ${detail}`;
    }

    // Activation answers from the service, but the voice that a turn will hear is
    // whatever `/api/models/active` reports next; a silent mismatch here would
    // otherwise only surface as a turn in the wrong voice.
    status = await client.status();
    if (!status.reachable) {
      return "the voice-conversion service became unreachable while activating its model";
    }
    if (status.activeModel !== expectedModel) {
      return (
        `the configured conversion model '${expectedModel}' did not become active ` +
        `(the service reports ${status.activeModel === null ? "none" : `'${status.activeModel}'`})`
      );
    }
  }

  // Remember what this model advertises before anything asks; a turn's per-agent
  // method is checked against this without paying for another service call.
  client.rememberAdvertisedF0Methods(status.f0Methods);

  // The shaping the voice agent asks for is only usable if the active model
  // advertises it; a name the service would reject otherwise fails at conversion
  // time, per sentence, instead of once at boot.
  if (expectedF0Method !== "" && !status.f0Methods.includes(expectedF0Method)) {
    const advertised = status.f0Methods.length
      ? ` (the service advertises: ${status.f0Methods.join(", ")})`
      : "";
    return (
      `the configured voice-agent F0 method '${expectedF0Method}' is not one the ` +
      `conversion service advertises${advertised}`
    );
  }

  return null;
}

/**
 * The configured supertonic voices the synthesis service does not hold.
 *
 * Returns null when the service's catalog could not be read — an unreachable
 * audio stack says nothing about which voices are installed, and must not be
 * reported as a voice misconfiguration.
 */
export async function unavailableConfiguredVoices(): Promise<string[] | null> {
  const held = await audioGateway.voiceCatalog();
  if (held === null) {
    return null;
  }
  return unavailableVoices(
    configuredSupertonicVoices(config.audio.voices.supertonic, {
      defaultEngine: config.audio.defaultEngine,
      defaultVoice: config.audio.defaultVoice,
    }),
    held
  );
}

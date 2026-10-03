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
import { audioGateway } from "./client";

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
  options: { defaultEngine: Engine; defaultVoice: string }
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

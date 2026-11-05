/**
 * The per-turn voice-conversion config a voice-agent turn may carry.
 *
 * The console stores a tri-state on each agent and the bridge sends it as the
 * turn's `ovc` field. The runtime is the authoritative boundary: it parses the
 * field, clamps every bounded value, and checks the F0 method against the set the
 * conversion service advertises. A malformed value is refused by name rather than
 * guessed at, because a turn that converts with the wrong voice is worse than one
 * that says it could not.
 */

import type { VoiceShaping } from "./client";

/** The offline methods the pinned conversion service accepts. */
export const OFFLINE_F0_METHODS = [
  "pm",
  "harvest",
  "dio",
  "crepe",
  "crepe-tiny",
  "mangio-crepe",
  "mangio-crepe-tiny",
  "rmvpe",
  "fcpe",
  "hybrid[crepe+rmvpe]",
  "hybrid[crepe+fcpe]",
  "hybrid[rmvpe+fcpe]",
  "hybrid[crepe+rmvpe+fcpe]",
] as const;

/** Every option the console may store, before the deployment defaults are merged in. */
export interface VoiceConversionConfig {
  pitchShift?: number;
  formantShift?: number;
  f0Method?: string;
  indexRate?: number;
  protect?: number;
  rmsMixRate?: number;
  filterRadius?: number;
  crepeHopLength?: number;
  effects?: Record<string, unknown>;
}

/** The voice agent's deployment defaults, from `AppConfig.audio.ovc.voiceAgent`. */
export interface VoiceAgentShapingDefaults {
  pitchShift: number;
  formantShift: number;
  f0Method: string;
}

export type ParsedVoiceConversion =
  | { ok: true; value: false | VoiceConversionConfig | undefined }
  | { ok: false; error: string };

function bounded(
  value: unknown,
  field: string,
  min: number,
  max: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `ovc.${field} must be a number` };
  }
  return { ok: true, value: Math.max(min, Math.min(max, value)) };
}

/**
 * Parse the turn's `ovc` field.
 *
 * `raw` is an object when the turn arrived as JSON and a string when it arrived
 * as multipart, which is how the bridge sends it. An absent or empty value is
 * inherit. `{"enabled": false}` is the explicit opt-out.
 */
export function parseVoiceConversionConfig(
  raw: unknown,
  advertised: readonly string[] = OFFLINE_F0_METHODS
): ParsedVoiceConversion {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "ovc must be valid JSON" };
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "ovc must be a JSON object" };
  }

  const source = parsed as Record<string, unknown>;
  if (source.enabled === false) {
    return { ok: true, value: false };
  }
  if ("enabled" in source && source.enabled !== true) {
    return { ok: false, error: "ovc.enabled must be true or false" };
  }

  const config: VoiceConversionConfig = {};

  if (source.pitchShift !== undefined) {
    const value = bounded(source.pitchShift, "pitchShift", -24, 24);
    if (!value.ok) return value;
    config.pitchShift = value.value;
  }
  if (source.formantShift !== undefined) {
    const value = bounded(source.formantShift, "formantShift", -24, 24);
    if (!value.ok) return value;
    config.formantShift = value.value;
  }
  if (source.f0Method !== undefined) {
    if (typeof source.f0Method !== "string") {
      return { ok: false, error: "ovc.f0Method must be a string" };
    }
    const method = source.f0Method.trim().toLowerCase();
    if (!advertised.includes(method)) {
      return {
        ok: false,
        error:
          `the configured F0 method '${method}' is not one the conversion service advertises` +
          (advertised.length > 0 ? ` (${advertised.join(", ")})` : ""),
      };
    }
    config.f0Method = method;
  }
  if (source.indexRate !== undefined) {
    const value = bounded(source.indexRate, "indexRate", 0, 1);
    if (!value.ok) return value;
    config.indexRate = value.value;
  }
  if (source.protect !== undefined) {
    const value = bounded(source.protect, "protect", 0, 0.5);
    if (!value.ok) return value;
    config.protect = value.value;
  }
  if (source.rmsMixRate !== undefined) {
    const value = bounded(source.rmsMixRate, "rmsMixRate", 0, 1);
    if (!value.ok) return value;
    config.rmsMixRate = value.value;
  }
  if (source.filterRadius !== undefined) {
    const value = bounded(source.filterRadius, "filterRadius", 0, 20);
    if (!value.ok) return value;
    config.filterRadius = Math.trunc(value.value);
  }
  if (source.crepeHopLength !== undefined) {
    const value = bounded(source.crepeHopLength, "crepeHopLength", 64, 512);
    if (!value.ok) return value;
    config.crepeHopLength = Math.trunc(value.value);
  }
  if (source.effects !== undefined) {
    if (
      typeof source.effects !== "object" ||
      source.effects === null ||
      Array.isArray(source.effects)
    ) {
      return { ok: false, error: "ovc.effects must be a JSON object" };
    }
    config.effects = source.effects as Record<string, unknown>;
  }

  return { ok: true, value: config };
}

/**
 * Merge a parsed per-turn config over the deployment's voice-agent defaults.
 *
 * `undefined` keeps today's behaviour; `false` is the opt-out; an object fills
 * every unset option from the deployment, so a value the agent did not name is
 * inherited rather than reset to zero.
 */
export function effectiveVoiceConversion(
  config: false | VoiceConversionConfig | undefined,
  defaults: VoiceAgentShapingDefaults
): VoiceShaping | false | undefined {
  if (config === false) return false;
  if (config === undefined) {
    if (
      defaults.pitchShift === 0 &&
      defaults.formantShift === 0 &&
      defaults.f0Method === ""
    ) {
      return undefined;
    }
    return {
      pitchShift: defaults.pitchShift,
      formantShift: defaults.formantShift,
      ...(defaults.f0Method === "" ? {} : { f0Method: defaults.f0Method }),
    };
  }

  const f0Method = config.f0Method ?? defaults.f0Method;
  return {
    pitchShift: config.pitchShift ?? defaults.pitchShift,
    formantShift: config.formantShift ?? defaults.formantShift,
    ...(f0Method === "" ? {} : { f0Method }),
    ...(config.indexRate === undefined ? {} : { indexRate: config.indexRate }),
    ...(config.protect === undefined ? {} : { protect: config.protect }),
    ...(config.rmsMixRate === undefined ? {} : { rmsMixRate: config.rmsMixRate }),
    ...(config.filterRadius === undefined ? {} : { filterRadius: config.filterRadius }),
    ...(config.crepeHopLength === undefined
      ? {}
      : { crepeHopLength: config.crepeHopLength }),
    ...(config.effects === undefined ? {} : { effects: config.effects }),
  };
}

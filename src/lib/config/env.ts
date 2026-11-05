/**
 * Parse a positive integer from the environment, falling back when the value is
 * absent, non-numeric, or not positive. Used for timeouts and limits, where a
 * bad value silently disabling the guard would be worse than the default.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * Parse a boolean from the environment, falling back when the variable is
 * absent. Only `true`, case-insensitively, is true; any other set value is
 * false, so a typo reads as the safer value rather than as an unexpected on.
 */
export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() === "true";
}

/**
 * Parse a comma-separated list from the environment, falling back when the
 * variable is absent or holds nothing but separators.
 *
 * A variable that is *set* to blank is honoured as the empty list rather than
 * replaced by the fallback, because for the lists this parses, empty is a real
 * value and a meaningful one: an empty speakable-collection set is a deployment
 * that speaks no material at all, which an operator may want to say explicitly
 * rather than by relying on the environment's default.
 */
export function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : [];
}

/**
 * Parse a number in [0, 1] from the environment, falling back when the value is
 * absent or names no such number.
 *
 * The range is the point rather than a detail: the value this parses is compared
 * against a relevance score, which is a similarity in that interval, so a value
 * outside it would compare against nothing and mean the opposite of what it
 * looks like it means — above 1 refuses every hit, below 0 accepts every one.
 * Zero is allowed, since "speak any hit" is a choice an operator may make.
 */
export function parseUnitInterval(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isNaN(parsed) || parsed < 0 || parsed > 1 ? fallback : parsed;
}

/**
 * Parse a pitch or formant shift, in semitones, from the environment.
 *
 * Values outside ±24 are clamped rather than refused: that is the range the
 * conversion service accepts, and a value it would clip silently would let the
 * audible voice differ from what the deployment's configuration says. An absent
 * or unparseable value falls back, as the other parsers do.
 */
export function parseSemitones(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(-24, Math.min(24, parsed));
}

/**
 * Parse a non-negative multiplier from the environment, falling back when the
 * value is absent, unparseable, or negative.
 *
 * Unlike `parseUnitInterval` there is no upper bound: the point of a volume is to
 * be able to ask for more than the engine gave, and the value that cannot be
 * honoured (one that would clip) is handled where the samples are, by clamping
 * and saying so. Negative is refused rather than clamped to zero because a
 * negative gain inverts the waveform rather than attenuating it — audible as a
 * phase-flipped signal, and not what anyone means by typing a volume. Zero is
 * allowed: muting an engine is a real choice.
 *
 * Not `parsePositiveInt`, which would read "0.5" as 0.
 */
export function parseGain(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

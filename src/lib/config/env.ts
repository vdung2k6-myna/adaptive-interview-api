/**
 * Parse a positive integer from the environment, falling back when the value is
 * absent, non-numeric, or not positive. Used for timeouts and limits, where a
 * bad value silently disabling the guard would be worse than the default.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

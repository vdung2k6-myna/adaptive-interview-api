/**
 * The provider profiles a deployment publishes to its voice-agent surface.
 *
 * The catalog is operator configuration, not a table: the browser only chooses
 * from what the operator wrote, so there is no account to own a row and no key a
 * browser could reach. It is read from `PROVIDER_CATALOG` at boot and refused
 * whole if any entry is malformed — a catalog with one bad profile would
 * otherwise fail on the turn that named it, long after the mistake was made.
 */

export const PROVIDER_KINDS = ["llm", "stt", "tts"] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderProfile {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  /** The voice a `tts` profile speaks in; absent for the other kinds. */
  voice?: string;
  /** The key, when the provider needs one. Never returned to a browser. */
  apiKey?: string;
}

export interface PublicProviderProfile {
  id: string;
  kind: ProviderKind;
  name: string;
  model: string;
  voice: string | null;
  hasKey: boolean;
}

/** What a browser may see: the key is reduced to whether one is set. */
export function publicProviderProfile(profile: ProviderProfile): PublicProviderProfile {
  return {
    id: profile.id,
    kind: profile.kind,
    name: profile.name,
    model: profile.model,
    voice: profile.voice ?? null,
    hasKey: profile.apiKey !== undefined && profile.apiKey !== "",
  };
}

export function publicProviderProfiles(
  catalog: readonly ProviderProfile[]
): PublicProviderProfile[] {
  return catalog.map(publicProviderProfile);
}

export function findProvider(
  catalog: readonly ProviderProfile[],
  id: string | undefined
): ProviderProfile | undefined {
  if (id === undefined || id === "") return undefined;
  return catalog.find((profile) => profile.id === id);
}

/** The profile that answers a turn naming none of its kind. */
export function defaultProviderFor(
  catalog: readonly ProviderProfile[],
  kind: ProviderKind,
  defaults: Readonly<Record<ProviderKind, string | null>>
): ProviderProfile | undefined {
  const id = defaults[kind];
  if (id === null) return undefined;
  const profile = findProvider(catalog, id);
  return profile !== undefined && profile.kind === kind ? profile : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

/**
 * Read the catalog, refusing the deployment rather than a later turn.
 *
 * A malformed catalog is a configuration mistake, and the turn that would have
 * discovered it is the wrong place to learn: boot is when someone can still fix
 * it without a person waiting on a gadget.
 */
export function parseProviderCatalog(raw: string | undefined, source: string): ProviderProfile[] {
  if (raw === undefined || raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${source} must be JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON array of provider profiles`);
  }

  const seen = new Set<string>();
  return parsed.map((entry: unknown, index: number) => {
    const where = `${source}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${where} must be an object`);

    const id = text(entry.id);
    const kind = text(entry.kind);
    const name = text(entry.name);
    const baseUrl = text(entry.baseUrl);
    const model = text(entry.model);
    const voice = text(entry.voice);
    const apiKey = text(entry.apiKey);

    if (id === "") throw new Error(`${where}.id is required`);
    if (seen.has(id)) throw new Error(`${where}.id ${JSON.stringify(id)} is used twice`);
    if (!(PROVIDER_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`${where}.kind must be one of ${PROVIDER_KINDS.join(", ")}`);
    }
    if (name === "") throw new Error(`${where}.name is required`);
    if (!isHttpUrl(baseUrl)) throw new Error(`${where}.baseUrl must be an absolute http(s) URL`);
    if (model === "") throw new Error(`${where}.model is required`);
    if (kind === "tts" && voice === "") {
      throw new Error(`${where}.voice is required for a tts profile`);
    }

    seen.add(id);
    return {
      id,
      kind: kind as ProviderKind,
      name,
      baseUrl,
      model,
      ...(kind === "tts" ? { voice } : {}),
      ...(apiKey === "" ? {} : { apiKey }),
    };
  });
}

const DEFAULT_NAMES: Record<ProviderKind, string> = {
  llm: "PROVIDER_DEFAULT_LLM",
  stt: "PROVIDER_DEFAULT_STT",
  tts: "PROVIDER_DEFAULT_TTS",
};

/**
 * Which profile answers a turn that names none, per kind.
 *
 * A default that names no profile, or one of another kind, is refused at boot
 * for the same reason a malformed entry is: a deployment whose fallback is
 * wrong should not start pretending it has one.
 */
export function parseProviderDefaults(
  env: NodeJS.ProcessEnv,
  catalog: readonly ProviderProfile[]
): Record<ProviderKind, string | null> {
  const defaults = {} as Record<ProviderKind, string | null>;
  for (const kind of PROVIDER_KINDS) {
    const source = DEFAULT_NAMES[kind];
    const id = (env[source] ?? "").trim();
    if (id === "") {
      defaults[kind] = null;
      continue;
    }
    const profile = findProvider(catalog, id);
    if (profile === undefined) {
      throw new Error(`${source} names no profile in PROVIDER_CATALOG: ${JSON.stringify(id)}`);
    }
    if (profile.kind !== kind) {
      throw new Error(`${source} names a ${profile.kind} profile, not a ${kind} one`);
    }
    defaults[kind] = id;
  }
  return defaults;
}

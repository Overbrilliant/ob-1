// Keys file management for the embedded free-models router — ~/.ob1/keys.env (0o600).
//
// One editable env-style file is the whole UX: add a key after any `=`, save, and that provider's models
// activate and route automatically (no restart). Keyless providers work with an empty file. Keys never
// leave this machine except to call the provider directly. The template is GENERATED FROM the registry so
// it can never drift from the providers OB-1 actually supports.
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalSettingsDir } from "../../config.ts";
import { FREE_PROVIDERS, type FreeProvider } from "./registry.ts";

/** Absolute path to the keys file. Honors OB1_SETTINGS_DIR via globalSettingsDir(). */
export function keysFilePath(): string {
  return join(globalSettingsDir(), "keys.env");
}

// The known key variable names (every provider's `<ID>_API_KEY`), for the unknown-name warning surface.
const KNOWN_ENV_NAMES = new Set(FREE_PROVIDERS.map((p) => p.keyEnvName));
const BY_ENV_NAME = new Map<string, FreeProvider>(FREE_PROVIDERS.map((p) => [p.keyEnvName, p]));

/** Providers shown in the "best free tiers" group, in the exact intended template order. */
const RECOMMENDED_ORDER = ["google", "groq", "openrouter", "github", "nvidia", "cerebras", "mistral"];

function providerLine(p: FreeProvider): string {
  const note = p.keyNote ? ` (${p.keyNote})` : "";
  return `# ${p.name} — ${p.signupUrl}${note}\n${p.keyEnvName}=`;
}

/** Build the keys.env template from the registry: a header explaining the mechanic, a "Recommended" group,
 *  a "More providers" group (alphabetical), then a comment-only "always on" note for the keyless four. */
export function buildKeysTemplate(): string {
  const recommended = RECOMMENDED_ORDER.map((id) => FREE_PROVIDERS.find((p) => p.id === id)).filter(
    (p): p is FreeProvider => !!p,
  );
  const recommendedIds = new Set(RECOMMENDED_ORDER);
  const more = FREE_PROVIDERS.filter((p) => !p.keyless && !recommendedIds.has(p.id)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const lines: string[] = [
    "# ─────────────────────────────────────────────────────────────────────────",
    "# OB-1 free models — your API keys",
    "# ─────────────────────────────────────────────────────────────────────────",
    "#",
    "# Add a key after any `=` and SAVE — that provider's models activate and are",
    "# routed automatically. No restart needed. Remove a key to deactivate it.",
    "#",
    "# Keys never leave this machine except to call the provider directly. Keyless",
    "# providers (bottom) work with no setup at all.",
    "#",
    "# Lines starting with `#` are comments. Values may be quoted. Example:",
    "#   GROQ_API_KEY=gsk_your_key_here",
    "#",
    "",
    "# ── Recommended (best free tiers) ──────────────────────────────────────────",
    "",
    ...recommended.map((p) => providerLine(p) + "\n"),
    "# ── More providers ─────────────────────────────────────────────────────────",
    "",
    ...more.map((p) => providerLine(p) + "\n"),
    "# ── No key needed — always on ──────────────────────────────────────────────",
    "# Kilo, Pollinations, OVH and LLM7 route with zero setup — nothing to add here.",
    "# LLM7 also accepts an OPTIONAL key to raise its limits; uncomment and fill in:",
    "# LLM7_API_KEY=",
    "",
  ];
  return lines.join("\n");
}

/** Create the keys file with the template if it does NOT exist (never overwrites a user's file). Returns
 *  the path either way. Written 0o600 in a 0o700 dir (it holds secrets), matching the settings.json pattern. */
export function ensureKeysFile(): string {
  const path = keysFilePath();
  if (existsSync(path)) return path;
  try {
    const dir = globalSettingsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, buildKeysTemplate(), { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* perms best-effort (Windows) */
    }
  } catch {
    /* best-effort — a failed create just means no keyed providers until it can be written */
  }
  return path;
}

/** Strip a matching pair of surrounding quotes from a value (single or double); otherwise unchanged. */
function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export interface ParsedKeys {
  /** Active keys by PROVIDER id (only non-empty values for a recognized `<ID>_API_KEY`). */
  byProvider: Map<string, string>;
  /** Variable names present in the file that don't match any provider (surfaced as a warning). */
  unknown: string[];
}

/** Parse env-style content: `NAME=value`, `#` comments, blank lines. Trims, strips matching quotes, tracks
 *  unknown names. A recognized name with an empty value is treated as "not set" (activates nothing). */
export function parseKeysEnv(content: string): ParsedKeys {
  const byProvider = new Map<string, string>();
  const unknown: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no `=`, or a bare `=value` → ignore
    const name = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1).trim());
    const provider = BY_ENV_NAME.get(name);
    if (!provider) {
      if (!KNOWN_ENV_NAMES.has(name)) unknown.push(name);
      continue;
    }
    if (value) byProvider.set(provider.id, value);
  }
  return { byProvider, unknown };
}

// ── Cached load (re-read only when the file's mtime/size changes) ─────────────
interface KeysCache {
  path: string;
  mtimeMs: number;
  size: number;
  parsed: ParsedKeys;
}
let keysCache: KeysCache | null = null;

/** Load the parsed keys, re-reading ONLY when the file changed (keyed on mtimeMs+size — a cheap stat per
 *  turn). A missing file yields empty active keys (keyless providers still route). */
export function loadKeys(): ParsedKeys {
  const path = keysFilePath();
  let mtimeMs = 0;
  let size = 0;
  try {
    const s = statSync(path);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    // Missing file → empty keys (do not auto-create here; ensureKeysFile() is the explicit creator).
    keysCache = { path, mtimeMs: 0, size: 0, parsed: { byProvider: new Map(), unknown: [] } };
    return keysCache.parsed;
  }
  if (keysCache && keysCache.path === path && keysCache.mtimeMs === mtimeMs && keysCache.size === size) {
    return keysCache.parsed;
  }
  let parsed: ParsedKeys = { byProvider: new Map(), unknown: [] };
  try {
    parsed = parseKeysEnv(readFileSync(path, "utf8"));
  } catch {
    /* unreadable → treat as empty */
  }
  keysCache = { path, mtimeMs, size, parsed };
  return parsed;
}

/** True if the keys file changed since the last loadKeys() cache (used to trigger a health re-check). */
export function keysChangedSinceCache(): boolean {
  const path = keysFilePath();
  try {
    const s = statSync(path);
    return !keysCache || keysCache.path !== path || keysCache.mtimeMs !== s.mtimeMs || keysCache.size !== s.size;
  } catch {
    return !!keysCache && keysCache.size !== 0;
  }
}

/** Drop the keys cache (tests only) so the next loadKeys() re-reads from disk. */
export function resetKeysCache(): void {
  keysCache = null;
}

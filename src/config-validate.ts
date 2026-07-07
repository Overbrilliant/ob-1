// Settings schema validation (parity with claw-code's config_validate).
//
// A hand-edited or partially-written ~/.ob1/settings.json must never silently mis-apply (e.g.
// sandbox:"yolo" or mode:42). validateSettings type-checks each known field against the schema,
// DROPS anything invalid (so the built-in default applies instead), and reports structured errors +
// warnings for unknown keys. Pure + dependency-free; loadPersisted() sanitizes through it, and a
// /doctor-style check can surface the messages.
import type { PersistedSettings } from "./config.ts";
import { PROFILES } from "./providers/profiles.ts";

const ENUMS: Record<string, readonly string[]> = {
  provider: ["openai", "free"],
  mode: ["solo", "fusion"],
  permissionMode: ["ask", "autopilot"],
  sandbox: ["off", "read-only", "workspace-write"],
  effort: ["low", "medium", "high"],
  qualityMode: ["off", "normal", "strict"],
  freeStrategy: ["priority", "balanced", "smartest", "fastest", "reliable"],
};
// Modes retired in the multimind v2 rework (council/personas + the old adaptive router). Still ACCEPTED
// by the validator (not dropped as invalid) so the persisted value SURVIVES to loadConfig, whose one-time
// migration collapses it to Solo and rewrites the file. Mirrors LEGACY_PROVIDER_PROFILES below; the error
// message for a genuinely bad mode still lists only the CURRENT modes.
const LEGACY_MODE_VALUES = ["council", "personas", "adaptive"];
const BOOLS = [
  "planMode",
  "subagents",
  "escalation",
  "repoMap",
  "memEvolve",
  "memReflect",
  "memAutolink",
  "skillLearn",
  "checkpoint",
] as const;
const STRINGS = ["model", "providerUrl", "providerKey"] as const;
const PROVIDER_PROFILES = PROFILES.map((p) => p.id);
// Legacy providerProfile ids that no longer exist in PROFILES but must still VALIDATE (not be dropped) so
// loadPersisted's one-time migration can see and rewrite them. Critical ordering: validateSettings runs
// BEFORE migrateFreellmapiToFree — without this alias a legacy "freellmapi" value would be stripped here
// and the migration would never fire, silently un-onboarding the user. See migrateFreellmapiToFree (config.ts).
const LEGACY_PROVIDER_PROFILES = ["freellmapi"];
const ACCEPTED_PROVIDER_PROFILES = [...PROVIDER_PROFILES, ...LEGACY_PROVIDER_PROFILES];
const KNOWN = new Set<string>([...Object.keys(ENUMS), ...BOOLS, ...STRINGS, "providerCreds"]);
KNOWN.add("providerProfile");

export interface SettingsIssue {
  field: string;
  message: string;
}
export interface ValidationReport {
  ok: boolean; // true when there were no ERRORS (warnings don't flip this)
  value: PersistedSettings; // sanitized: only valid fields survive
  errors: SettingsIssue[]; // invalid values that were dropped
  warnings: SettingsIssue[]; // unknown keys (ignored) + soft issues
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Validate a parsed settings object. Never throws; returns a sanitized value + structured issues. */
export function validateSettings(raw: unknown): ValidationReport {
  const errors: SettingsIssue[] = [];
  const warnings: SettingsIssue[] = [];
  const value: Record<string, unknown> = {};
  if (!isPlainObject(raw)) {
    return { ok: false, value: {}, errors: [{ field: "(root)", message: "settings must be a JSON object" }], warnings };
  }

  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined || val === null) continue; // absent → default, not an error
    if (key in ENUMS) {
      // A retired mode value validates (survives for loadConfig's collapse-to-Solo migration) even though
      // it's no longer a current mode — see LEGACY_MODE_VALUES.
      const legacyMode = key === "mode" && typeof val === "string" && LEGACY_MODE_VALUES.includes(val);
      if (typeof val === "string" && (ENUMS[key].includes(val) || legacyMode)) value[key] = val;
      else
        errors.push({
          field: key,
          message: `invalid ${key}: ${JSON.stringify(val)} — expected one of ${ENUMS[key].join(" | ")}`,
        });
    } else if ((BOOLS as readonly string[]).includes(key)) {
      if (typeof val === "boolean") value[key] = val;
      else errors.push({ field: key, message: `invalid ${key}: ${JSON.stringify(val)} — expected a boolean` });
    } else if ((STRINGS as readonly string[]).includes(key)) {
      if (typeof val === "string") value[key] = val;
      else errors.push({ field: key, message: `invalid ${key}: ${JSON.stringify(val)} — expected a string` });
    } else if (key === "providerProfile") {
      // Accept legacy aliases (e.g. "freellmapi") so the value survives validation for the migration to
      // rewrite it; the error message still lists only the CURRENT profiles.
      if (typeof val === "string" && ACCEPTED_PROVIDER_PROFILES.includes(val)) value[key] = val;
      else
        errors.push({
          field: key,
          message: `invalid providerProfile: ${JSON.stringify(val)} — expected one of ${PROVIDER_PROFILES.join(" | ")}`,
        });
    } else if (key === "providerCreds") {
      if (isPlainObject(val)) {
        const creds: Record<string, { url: string; key: string }> = {};
        for (const [pid, entry] of Object.entries(val)) {
          if (!PROVIDER_PROFILES.includes(pid)) {
            warnings.push({ field: `providerCreds.${pid}`, message: `unknown provider profile "${pid}" (ignored)` });
            continue;
          }
          if (isPlainObject(entry) && typeof entry.url === "string" && typeof entry.key === "string")
            creds[pid] = { url: entry.url, key: entry.key };
          else
            errors.push({ field: `providerCreds.${pid}`, message: "each entry must be { url: string, key: string }" });
        }
        if (Object.keys(creds).length) value.providerCreds = creds;
      } else errors.push({ field: "providerCreds", message: "expected an object of { url, key } entries" });
    } else {
      warnings.push({ field: key, message: `unknown setting "${key}" (ignored)` });
    }
  }

  return { ok: errors.length === 0, value: value as PersistedSettings, errors, warnings };
}

/** One-line-per-issue formatting for a doctor/startup report. Empty string when clean. */
export function formatSettingsIssues(r: ValidationReport): string {
  const lines: string[] = [];
  for (const e of r.errors) lines.push(`  ✗ ${e.field}: ${e.message}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w.field}: ${w.message}`);
  return lines.join("\n");
}

// Deterministic test for settings schema validation (no fs/network).
// Usage: bun run scripts/config-validate-smoke.ts
import { validateSettings, formatSettingsIssues } from "../src/config-validate.ts";

let fail = false;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "✓" : "✗"} ${n}`); if (!ok) fail = true; };

// ── valid settings pass clean ─────────────────────────────────────────────────
const good = validateSettings({
  provider: "openai", model: "qwen/qwen3.6-plus", mode: "solo", permissionMode: "autopilot",
  sandbox: "workspace-write", effort: "high", qualityMode: "strict", planMode: false, repoMap: true, checkpoint: true,
  providerProfile: "openrouter", providerUrl: "https://x/v1", providerKey: "k",
  providerCreds: { openrouter: { url: "https://x/v1", key: "k" } },
});
check("valid settings → ok, no errors", good.ok && good.errors.length === 0);
check("valid settings preserved verbatim", good.value.mode === "solo" && good.value.sandbox === "workspace-write" && good.value.effort === "high" && good.value.qualityMode === "strict");
check("valid providerCreds preserved", good.value.providerCreds?.openrouter?.key === "k");

// ── invalid enum / type values are DROPPED with an error (default applies) ─────
const bad = validateSettings({ mode: "yolo", sandbox: 42, permissionMode: "ask", planMode: "yes", effort: "extreme", qualityMode: "max", model: "m" });
check("invalid enum (mode) → error + dropped", bad.errors.some((e) => e.field === "mode") && !("mode" in bad.value));
check("invalid type (sandbox number) → error + dropped", bad.errors.some((e) => e.field === "sandbox") && !("sandbox" in bad.value));
check("invalid bool (planMode string) → error + dropped", bad.errors.some((e) => e.field === "planMode") && !("planMode" in bad.value));
check("invalid effort → error + dropped", bad.errors.some((e) => e.field === "effort"));
check("invalid qualityMode → error + dropped", bad.errors.some((e) => e.field === "qualityMode") && !("qualityMode" in bad.value));
check("VALID fields survive alongside invalid ones", bad.value.permissionMode === "ask" && bad.value.model === "m");
check("ok=false when there are errors", bad.ok === false);

// ── unknown keys → warning (ignored), not an error ────────────────────────────
const unknown = validateSettings({ mode: "fusion", bogusKey: 1, anotherJunk: true });
check("unknown key → warning, not error", unknown.errors.length === 0 && unknown.warnings.some((w) => w.field === "bogusKey"));
check("unknown key is NOT carried into the value", !("bogusKey" in unknown.value) && unknown.value.mode === "fusion");

// ── malformed providerCreds entry ─────────────────────────────────────────────
const creds = validateSettings({ providerCreds: { ok: { url: "u", key: "k" }, broken: { url: 1 } } });
check("good cred entry kept, broken entry errors", creds.value.providerCreds?.ok?.url === "u" && creds.errors.some((e) => e.field === "providerCreds.broken"));

// ── non-object root ───────────────────────────────────────────────────────────
check("array root → error, empty value", validateSettings([1, 2]).ok === false && Object.keys(validateSettings([1, 2]).value).length === 0);
check("string root → error", validateSettings("nope").ok === false);
check("empty object → ok, no issues", (() => { const r = validateSettings({}); return r.ok && r.errors.length === 0 && r.warnings.length === 0; })());

// ── formatting ────────────────────────────────────────────────────────────────
check("formatSettingsIssues renders ✗ for errors and ⚠ for warnings", (() => {
  const s = formatSettingsIssues(validateSettings({ mode: "bad", junk: 1 }));
  return s.includes("✗") && s.includes("⚠") && s.includes("mode");
})());

if (fail) { console.error("\n✗ config-validate smoke FAILED"); process.exit(1); }
console.log("\n✓ config-validate smoke passed");

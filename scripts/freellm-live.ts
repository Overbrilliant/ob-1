// LIVE test against a real FreeLLMAPI server — NOT in the CI suite (needs network + a running proxy).
// Creds come from the environment so no secret is committed:
//   OB1_FREELLM_URL=https://host/v1  OB1_FREELLM_KEY=freellmapi-…  bun run scripts/freellm-live.ts
// Exercises the exact path /models configures: GET /models, then a streamed chat completion through
// the OpenAI-compatible provider (callOpenAI) using the FreeLLMAPI `auto` router model.
import { normalizeBaseUrl, fetchModels } from "../src/providers/profiles.ts";
import { callOpenAI } from "../src/providers/openai.ts";

const url = normalizeBaseUrl(process.env.OB1_FREELLM_URL ?? "");
const key = process.env.OB1_FREELLM_KEY ?? "";
if (!url || !key) {
  console.error("✗ set OB1_FREELLM_URL and OB1_FREELLM_KEY to run the live test");
  process.exit(2);
}

let fail = false;
const check = (n: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${n}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

console.log(`→ ${url}`);
const conn = await fetchModels(url, key);
check("GET /models succeeds", conn.ok, conn.ok ? `${conn.models.length} models` : conn.error);
if (conn.ok) {
  console.log("  models: " + conn.models.slice(0, 8).map((m) => m.id).join(", ") + (conn.models.length > 8 ? ", …" : ""));
  check("catalog includes the `auto` router model", conn.models.some((m) => m.id === "auto"));
}

// pick a concrete model (auto, if present) and run a tiny streamed completion
const model = conn.models.find((m) => m.id === "auto")?.id ?? conn.models[0]?.id ?? "auto";
console.log(`\n→ chat completion via "${model}"…`);
let streamed = "";
try {
  const res = await callOpenAI({
    provider: "openai", apiKey: key, baseUrl: url, model,
    system: "You are a terse assistant. Answer in one short sentence.",
    messages: [{ role: "user", content: "Reply with exactly: OB-1 online." }],
    onText: (d) => { streamed += d; process.stdout.write(d); },
  });
  console.log("");
  const text = res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  check("completion streamed text", streamed.length > 0);
  check("completion returned an assistant message", text.length > 0, `stop=${res.stop_reason}`);
  // Usage is OPTIONAL: some proxies (incl. this FreeLLMAPI build) omit the final usage chunk. The
  // provider handles undefined usage gracefully, so this is a note, not a failure.
  console.log(`· usage: ${res.usage ? `${res.usage.input_tokens} in / ${res.usage.output_tokens} out` : "not reported by this proxy (token meter stays at 0 — harmless)"}`);
} catch (e: any) {
  check("chat completion succeeds", false, e?.message ?? String(e));
}

if (fail) { console.error("\n✗ freellm LIVE test FAILED"); process.exit(1); }
console.log("\n✓ freellm live test passed (models + streamed chat completion)");
process.exit(0);

// Smoke: human-readable error formatting (explainError / renderError / link).
// Verifies raw `API <status>: {json}` upstream errors become a short, actionable message — no JSON dump,
// an upgrade action for 402, "continue" only when a retry could actually help.
import { explainError, renderError, link } from "../src/cli/ui.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}`); }
}

// The exact error from the user's report.
const E402 = `API 402: {"error":"No active plan. Subscribe to use intelligent models.","upgrade_url":"http://localhost:8787/upgrade","resets_in_days":3}`;

const e402 = explainError(E402);
check("402: human title (not 'API 402')", e402.title === "Subscription required");
check("402: detail is the server's human sentence", e402.detail === "No active plan. Subscribe to use intelligent models.");
check("402: surfaces the upgrade action with its url", e402.action?.label === "Upgrade your plan" && e402.action?.url === "http://localhost:8787/upgrade");
check("402: does NOT offer a pointless retry", e402.retry === false);
check("402: reset hint pluralised", e402.hint === "Credits reset in 3 days.");
const e402Exhausted = explainError(`API 402: {"error":"Monthly credits exhausted.","upgrade_url":"http://localhost:8787/upgrade","resets_in_days":1}`);
check("402 exhausted: names monthly credits", e402Exhausted.title === "Monthly credits exhausted" && e402Exhausted.action?.label === "Upgrade for more credits");
check("402 exhausted: reminds self-hosted routes still work", /FreeLLMAPI/.test(e402Exhausted.hint ?? "") && /1 day/.test(e402Exhausted.hint ?? ""));

// The rendered block: no raw JSON, no naked url when hyperlinks degrade, carries the action label.
const r402 = renderError(E402);
check("402 render: drops the raw JSON body", !r402.includes("{") && !r402.includes("upgrade_url"));
check("402 render: no 'say continue' for a non-retryable error", !/continue/i.test(r402));
check("402 render: includes the action label", r402.includes("Upgrade your plan"));
check("402 render: shows the URL somewhere reachable (link or fallback)", r402.includes("http://localhost:8787/upgrade") || r402.includes("\x1b]8;;"));

// 401 → sign-in guidance, no retry.
const e401 = explainError(`API 401: {"error":"token expired"}`);
check("401: sign-in title + login hint", e401.title === "Sign-in needed" && /ob1 login/.test(e401.hint ?? "") && e401.retry === false);
const e401Free = explainError(`API 401: {"error":{"message":"Invalid API key"}}`, { providerProfile: "freellmapi" });
check("401 FreeLLMAPI: points to /freellm, not ob1 login", e401Free.title === "FreeLLMAPI authentication needed" && /\/freellm/.test(e401Free.hint ?? "") && !/ob1 login/.test(e401Free.hint ?? "") && e401Free.retry === false);
const e401Custom = explainError(`API 401: {"error":"bad key"}`, { providerProfile: "custom" });
check("401 Custom API: points to /models, not ob1 login", e401Custom.title === "Provider authentication failed" && /\/models/.test(e401Custom.hint ?? "") && !/ob1 login/.test(e401Custom.hint ?? "") && e401Custom.retry === false);
const e403Free = explainError(`API 403: {"error":"denied"}`, { providerProfile: "freellmapi" });
check("403 FreeLLMAPI: points to /freellm", e403Free.title === "FreeLLMAPI access denied" && /\/freellm/.test(e403Free.hint ?? "") && e403Free.retry === false);

// 429 / 5xx → retryable.
check("429: rate limited + retryable", explainError(`API 429: {"error":"slow down"}`).retry === true);
const e429Free = explainError(`API 429: {"error":"anonymous provider rate limit"}`, { providerProfile: "freellmapi" });
check("429 FreeLLMAPI: explains anonymous pool pressure", e429Free.title === "FreeLLMAPI anonymous pool busy" && /provider key/.test(e429Free.hint ?? "") && e429Free.retry === true);
check("5xx: provider error + retryable", (() => { const e = explainError(`API 503: upstream boom`); return e.title === "Provider error" && e.retry === true; })());

// OpenRouter-style nested error object.
const eNested = explainError(`API 400: {"error":{"message":"model not available","code":400}}`);
check("nested {error:{message}} extracted", eNested.detail === "model not available");

// Transport failures (no HTTP status).
const eNet = explainError("stream idle > 60s");
check("transport: connection-problem + retryable", eNet.title === "Connection problem" && eNet.retry === true);

// Retryable errors DO offer continue.
check("retryable render: offers 'continue'", /continue/i.test(renderError("fetch failed")));

// link(): degrades to "label (url)" when hyperlinks are disabled.
const prevTerm = process.env.OB1_NO_HYPERLINKS;
process.env.OB1_NO_HYPERLINKS = "1";
check("link: degrades to label (url) when disabled", link("Upgrade", "https://x.dev/up") === "Upgrade (https://x.dev/up)");
if (prevTerm === undefined) delete process.env.OB1_NO_HYPERLINKS; else process.env.OB1_NO_HYPERLINKS = prevTerm;

console.log(`\n${fail ? "✗" : "✓"} error-format smoke ${fail ? "FAILED" : "passed"} (${pass} passed, ${fail} failed)`);
if (fail) process.exit(1);

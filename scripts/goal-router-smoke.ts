// Regression smoke: /goal must honor Solo's auto-route escalation, just like a normal prompt.
// Drives the real non-TTY CLI against a tiny local OpenAI-compatible SSE server configured as Custom API;
// no network/API key.
// Usage: bun run scripts/goal-router-smoke.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let fail = false;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail = true;
};

const dec = new TextDecoder();
const enc = new TextEncoder();
const scriptDir = dirname(Bun.fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const tmp = mkdtempSync(join(tmpdir(), "ob1-goal-route-"));
const runCwd = join(tmp, "repo");
mkdirSync(runCwd, { recursive: true });

let calls = 0;
const sse = (objs: object[]) =>
  new Response(objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (!path.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    calls++;
    if (calls === 1) {
      return sse([{
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_goal_route",
              function: {
                name: "escalate",
                arguments: JSON.stringify({ mode: "fusion", reason: "goal needs candidate synthesis" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }]);
    }
    const text = calls === 3
      ? "GOAL_MET\n```ts\nexport const goalRouterSmoke = true;\n```"
      : "```ts\nexport const candidate = true;\n```";
    return sse([{
      choices: [{ delta: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
      model: "mock-model",
    }]);
  },
});

try {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OB1_BASE_URL",
    "OB1_MODEL",
    "OB1_PROVIDER",
    "OB1_SETTINGS_DIR",
    "OB1_TOKEN",
  ]) delete env[key];
  env.CI = "1";
  env.NO_COLOR = "1";
  env.HOME = join(tmp, "home");
  env.OB1_SETTINGS_DIR = join(tmp, "settings");
  mkdirSync(env.OB1_SETTINGS_DIR, { recursive: true });
  writeFileSync(join(env.OB1_SETTINGS_DIR, "settings.json"), JSON.stringify({
    provider: "openai",
    providerProfile: "custom",
    providerUrl: `http://127.0.0.1:${server.port}/v1`,
    providerKey: "test-key",
    model: "mock-model",
  }));
  env.OB1_AUTO_ROUTE = "on";
  env.OB1_APPLY = "0";
  env.OB1_CHECKPOINT = "off";
  env.OB1_FUSION_N = "1";
  env.OB1_GOAL_MAX_ITERS = "2";
  env.OB1_REPO_MAP = "off";
  env.OB1_SUGGEST = "0";
  env.OB1_TREESITTER = "0";
  env.OB1_VEC = "0";
  mkdirSync(env.HOME, { recursive: true });

  const proc = Bun.spawn(["bun", "run", join(root, "src/index.ts")], {
    cwd: runCwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const outP = new Response(proc.stdout).text();
  const errP = new Response(proc.stderr).text();
  proc.stdin.write(enc.encode("/goal build the routed thing\n/exit\n"));
  proc.stdin.end();

  const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 15_000));
  const completed = Promise.all([proc.exited, outP, errP] as const);
  const result = await Promise.race([completed, timeout]);
  if (result === "timeout") {
    try { proc.kill(); } catch { /* already gone */ }
    check("CLI finished without hanging", false, "timed out");
  } else {
    const [code, stdout, stderr] = result;
    const output = stdout + stderr;
    check("CLI exits cleanly", code === 0, output.slice(-300));
    check("/goal accepted Solo escalation", output.includes("Solo routed this to") && output.includes("goal needs candidate synthesis"), output.slice(-400));
    check("fusion actually ran after /goal escalation", output.includes("Fusion result:"), output.slice(-400));
    check("/goal sees GOAL_MET from escalated mode", output.includes("goal achieved"), output.slice(-400));
    check("mock model was called for route + fusion candidate + synthesizer", calls >= 3, String(calls));
  }
} finally {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
}

if (fail) {
  console.error("\n✗ goal-router smoke FAILED");
  process.exit(1);
}
console.log("\n✓ goal-router smoke passed");
process.exit(0);

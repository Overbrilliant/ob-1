// Offline smoke for the embedded free-models router (src/providers/free). Fully hermetic: a temp settings
// dir, background health disabled, and an injected `_call` seam (no network). Exercises the keys file,
// candidate gating/ordering, pin parsing, failover + no-failover-after-stream, learned limits, rate-limit
// windows, the Cloudflare compound-key connection, state persistence + corrupt recovery, and the
// freellmapi→free settings migration.  Usage: bun run scripts/free-router-smoke.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallOpts, ModelResponse } from "../src/providers/types.ts";
import { CATALOG, modelKey, providerById, resolveConnection, splitModelKey } from "../src/providers/free/registry.ts";
import {
  buildKeysTemplate,
  ensureKeysFile,
  keysFilePath,
  loadKeys,
  parseKeysEnv,
  resetKeysCache,
} from "../src/providers/free/keys.ts";
import {
  addPenalty,
  coolDownLadder,
  effectiveLimits,
  getPenalty,
  getState,
  isOnCooldown,
  learnLimitFromError,
  loadState,
  parseProviderLimit,
  reserveRequest,
  resetStateCache,
  saveStateNow,
  statePath,
  withinModelLimits,
} from "../src/providers/free/state.ts";
import { intelligenceComposite } from "../src/providers/free/scoring.ts";
import { selectCandidates } from "../src/providers/free/router.ts";
import { callFree, freeStatus, getFreeStrategy, listFreeModels } from "../src/providers/free/index.ts";
import { costForUsage, turnCost } from "../src/usage/log.ts";
import { loadConfig, persistedSettings } from "../src/config.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let fail = false;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "✓" : "✗"} ${n}${ok || !d ? "" : `  — ${d}`}`);
  if (!ok) fail = true;
};

const savedEnv = { ...process.env };
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k) || /^OB1_/.test(k)) delete process.env[k];

const tmp = mkdtempSync(join(tmpdir(), "ob1-free-"));
const settingsDir = join(tmp, ".ob1");
mkdirSync(settingsDir, { recursive: true });
process.env.OB1_SETTINGS_DIR = settingsDir;
process.env.OB1_FREE_DISABLE_BG = "1"; // no background health probes / network
const origCwd = process.cwd();
process.chdir(tmp);

/** Reset the router's in-memory + on-disk state between independent scenarios. */
function freshState(): void {
  resetStateCache();
  try {
    rmSync(statePath());
  } catch {
    /* not there */
  }
  resetStateCache();
}

/** Write keys.env and drop the parse cache so the next loadKeys() re-reads it. */
function writeKeys(content: string): void {
  writeFileSync(keysFilePath(), content);
  resetKeysCache();
}

function makeOpts(model: string, extra: Partial<CallOpts> = {}): CallOpts {
  return { provider: "free", apiKey: "", baseUrl: "", model, system: "You are a test.", messages: [{ role: "user", content: "hi" }], ...extra };
}

const okResponse = (): ModelResponse => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } });

async function run(): Promise<void> {
  // ── 1. keys.env template + parse round-trip ──────────────────────────────────
  const template = buildKeysTemplate();
  check("template lists a recommended provider key", template.includes("GROQ_API_KEY="));
  check("template documents the keyless always-on providers", /No key needed — always on/.test(template) && template.includes("LLM7_API_KEY="));
  check("template shows Cloudflare's compound-key note", template.includes("key format: ACCOUNT_ID:TOKEN"));

  const created = ensureKeysFile();
  check("ensureKeysFile creates the file at keysFilePath()", created === keysFilePath());
  writeFileSync(created, "# user edited\nGROQ_API_KEY=untouched\n");
  const again = ensureKeysFile();
  check("ensureKeysFile never overwrites an existing file", again === created && loadKeys().byProvider.get("groq") === "untouched");
  resetKeysCache();

  const parsed = parseKeysEnv(
    ['GROQ_API_KEY=gsk_plain', 'GOOGLE_API_KEY="quoted_value"', "CLOUDFLARE_API_KEY=acc123:tok456", "# a comment", "MISTRAL_API_KEY=", "WEIRD_KEY=nope", "  ", "NOEQUALS"].join("\n"),
  );
  check("parse maps a plain key by provider id", parsed.byProvider.get("groq") === "gsk_plain");
  check("parse strips matching quotes", parsed.byProvider.get("google") === "quoted_value");
  check("parse keeps a compound (cloudflare) value intact", parsed.byProvider.get("cloudflare") === "acc123:tok456");
  check("parse treats an empty value as unset", !parsed.byProvider.has("mistral"));
  check("parse tracks an unknown variable name", parsed.unknown.includes("WEIRD_KEY") && !parsed.unknown.includes("GROQ_API_KEY"));

  // ── 2. candidate availability (keyless-only vs +groq) ────────────────────────
  freshState();
  writeKeys("# empty\n");
  const now = Date.now();
  const emptySel = selectCandidates({ strategy: "balanced", requireTools: false, requireVision: false, estimatedTokens: 100, keys: loadKeys().byProvider, skip: new Set(), now });
  check("with no keys, some candidates exist (keyless providers)", emptySel.candidates.length > 0);
  check("with no keys, EVERY candidate is a keyless provider", emptySel.candidates.every((c) => c.provider.keyless));

  writeKeys("GROQ_API_KEY=gsk_test\n");
  const groqSel = selectCandidates({ strategy: "balanced", requireTools: false, requireVision: false, estimatedTokens: 100, keys: loadKeys().byProvider, skip: new Set(), now });
  check("adding a GROQ key makes groq models appear", groqSel.candidates.some((c) => c.platform === "groq"));

  // requireTools filters out non-tool models.
  const toolsSel = selectCandidates({ strategy: "balanced", requireTools: true, requireVision: false, estimatedTokens: 100, keys: loadKeys().byProvider, skip: new Set(), now });
  check("requireTools keeps only tool-capable models", toolsSel.candidates.every((c) => c.model.supportsTools));

  // ── 3. strategy ordering (deterministic reliability via fixed Math.random) ───
  freshState();
  writeKeys(["GROQ_API_KEY=g", "GOOGLE_API_KEY=x", "NVIDIA_API_KEY=n", "CEREBRAS_API_KEY=c"].join("\n") + "\n");
  const keys3 = loadKeys().byProvider;
  const realRandom = Math.random;
  Math.random = () => 0.5; // fixed draw ⇒ every fresh model samples the same reliability
  try {
    const smart = selectCandidates({ strategy: "smartest", requireTools: false, requireVision: false, estimatedTokens: 100, keys: keys3, skip: new Set(), now });
    const bestComposite = Math.max(...smart.candidates.map((c) => intelligenceComposite(c.model.sizeLabel, c.model.intelligenceRank)));
    const topComposite = intelligenceComposite(smart.candidates[0].model.sizeLabel, smart.candidates[0].model.intelligenceRank);
    check("smartest puts the highest-intelligence model first", topComposite === bestComposite, `${topComposite} vs ${bestComposite}`);

    const prio = selectCandidates({ strategy: "priority", requireTools: false, requireVision: false, estimatedTokens: 100, keys: keys3, skip: new Set(), now });
    const ranks = prio.candidates.map((c) => c.model.intelligenceRank);
    const nonDecreasing = ranks.every((r, i) => i === 0 || r >= ranks[i - 1]);
    check("priority orders by intelligenceRank ascending", nonDecreasing);
  } finally {
    Math.random = realRandom;
  }

  // ── 4. pin parsing + pinned-first selection ──────────────────────────────────
  const pin = splitModelKey("openrouter/qwen/qwen3-coder:free");
  check("pin splits on the FIRST slash", pin?.platform === "openrouter" && pin?.modelId === "qwen/qwen3-coder:free");
  check("a bare model id (no slash) is not a pin", splitModelKey("gpt-oss-120b") === undefined);

  freshState();
  writeKeys("OPENROUTER_API_KEY=or\n");
  const pinSel = selectCandidates({ strategy: "balanced", requireTools: false, requireVision: false, estimatedTokens: 100, keys: loadKeys().byProvider, pin: pin!, skip: new Set(), now });
  const pinId = modelKey("openrouter", "qwen/qwen3-coder:free");
  const pinExists = CATALOG.models.some((m) => modelKey(m.platform, m.modelId) === pinId && m.enabled);
  check("a servable pinned model is moved to the front", !pinExists || pinSel.candidates[0]?.id === pinId, pinSel.candidates[0]?.id);

  // ── 5. failover on injected 429 (cooldown + penalty + second candidate) ──────
  freshState();
  writeKeys("GROQ_API_KEY=gsk\n");
  const calledModels: string[] = [];
  let firstThrew = false;
  const failover = async (o: CallOpts): Promise<ModelResponse> => {
    calledModels.push(o.model);
    if (calledModels.length === 1) {
      firstThrew = true;
      throw new Error("API 429: Rate limit reached. Limit 6000 tokens per minute");
    }
    return { ...okResponse(), model: o.model };
  };
  const resp5 = await callFree(makeOpts("auto"), failover);
  check("failover: two distinct candidates were tried", calledModels.length === 2 && calledModels[0] !== calledModels[1], calledModels.join(" → "));
  check("failover: the second candidate's response is returned", resp5.content[0].type === "text");
  check("failover: resolved model is set to a platform/modelId", !!resp5.model && resp5.model.includes("/"));
  const st5 = getState();
  const cooledFirst = Object.keys(st5.cooldowns).some((k) => k.endsWith("/" + calledModels[0]));
  const penalizedFirst = Object.keys(st5.penalties).some((k) => k.endsWith("/" + calledModels[0]));
  check("failover: the 429'd model was put on cooldown", firstThrew && cooledFirst);
  check("failover: the 429'd model gained a penalty", penalizedFirst);
  const learnedTpm = Object.values(st5.learnedLimits).some((l) => l.tpm === 6000);
  check("failover: the real TPM limit was learned from the 429 body", learnedTpm);

  // ── 6. NO failover after streamed text ───────────────────────────────────────
  freshState();
  writeKeys("GROQ_API_KEY=gsk\n");
  let streamCalls = 0;
  let streamed = "";
  const streamThenFail = async (o: CallOpts): Promise<ModelResponse> => {
    streamCalls++;
    o.onText?.("partial answer");
    throw new Error("API 500: upstream exploded");
  };
  let noFailoverThrew = false;
  try {
    await callFree(makeOpts("auto", { onText: (d) => (streamed += d) }), streamThenFail);
  } catch {
    noFailoverThrew = true;
  }
  check("no-failover: a post-stream failure is rethrown, not retried", noFailoverThrew && streamCalls === 1, `calls=${streamCalls}`);
  check("no-failover: the streamed delta reached the caller", streamed === "partial answer");

  // ── 7. learnLimitFromError lowers a limit ────────────────────────────────────
  freshState();
  const lp = parseProviderLimit("...on tokens per minute (TPM): Limit 30000, Requested 33476");
  check("parseProviderLimit reads axis + ceiling", lp?.kind === "tpm" && lp?.limit === 30000);
  const tpmModel = CATALOG.models.find((m) => m.enabled && m.limits.tpm != null && (m.limits.tpm as number) > 5000);
  if (tpmModel) {
    const learned = learnLimitFromError(tpmModel.platform, tpmModel.modelId, "exceeded tokens per minute: Limit 5000");
    const eff = effectiveLimits(tpmModel);
    check("learnLimitFromError lowers the effective TPM", learned?.limit === 5000 && eff.tpm === 5000, `eff.tpm=${eff.tpm}`);
  } else {
    check("learnLimitFromError lowers the effective TPM", false, "no catalog model with tpm>5000 to test");
  }

  // ── 8. window accounting: rpd exhaustion blocks, next UTC day unblocks ────────
  freshState();
  const rpdModel = CATALOG.models.find((m) => m.enabled && m.limits.rpd != null && (m.limits.rpd as number) <= 60);
  if (rpdModel) {
    const rpd = rpdModel.limits.rpd as number;
    const day0 = Math.floor(Date.now() / DAY) * DAY + HOUR; // 01:00 UTC, comfortably inside a day
    for (let i = 0; i < rpd; i++) reserveRequest(rpdModel.platform, rpdModel.modelId, 0, day0 + i * MINUTE);
    const checkAt = day0 + rpd * MINUTE;
    check(`window blocks once rpd (${rpd}) is exhausted`, !withinModelLimits(rpdModel, 0, checkAt));
    check("window unblocks on the next UTC day", withinModelLimits(rpdModel, 0, day0 + DAY + HOUR));
  } else {
    check("window blocks once rpd is exhausted", false, "no small-rpd catalog model to test");
  }

  // ── 9. Cloudflare ACCOUNT_ID:TOKEN connection resolution ─────────────────────
  const cf = providerById("cloudflare")!;
  const cfConn = resolveConnection(cf, "acct-abc:secret-token");
  check("cloudflare URL embeds the account id", cfConn.baseUrl === "https://api.cloudflare.com/client/v4/accounts/acct-abc/ai/v1");
  check("cloudflare bearer is the token after the first colon", cfConn.apiKey === "secret-token");
  const groqConn = resolveConnection(providerById("groq")!, "gsk_x");
  check("default connection passes the key through unchanged", groqConn.apiKey === "gsk_x" && groqConn.baseUrl === "https://api.groq.com/openai/v1");

  // ── 10. state persistence round-trip + corrupt-file recovery ─────────────────
  freshState();
  addPenalty("groq", "llama-3.3-70b-versatile", Date.now());
  coolDownLadder("groq", "llama-3.3-70b-versatile", Date.now());
  saveStateNow();
  resetStateCache();
  const reloaded = loadState();
  check("state penalty survives a save/reload", getPenalty("groq", "llama-3.3-70b-versatile", Date.now()) > 0 && reloaded.v === 1);
  check("state cooldown survives a save/reload", isOnCooldown("groq", "llama-3.3-70b-versatile", Date.now()));
  writeFileSync(statePath(), "{ this is not json ]");
  resetStateCache();
  const recovered = loadState();
  check("corrupt state file recovers to a fresh state", recovered.v === 1 && Object.keys(recovered.cooldowns).length === 0);

  // ── 11. settings migration freellmapi → free ─────────────────────────────────
  rmSync(join(settingsDir, "settings.json"), { force: true });
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ provider: "openai", providerProfile: "freellmapi", model: "auto", providerUrl: "http://localhost:3001/v1", providerKey: "k" }));
  const cfg = loadConfig();
  check("migration: provider profile freellmapi → free", cfg.providerProfile === "free" && cfg.provider === "free");
  check("migration: model reset to auto", cfg.model === "auto");
  check("migration: rewrite is persisted to disk", persistedSettings(settingsDir).providerProfile === "free");
  check(
    "migration: stale providerUrl/providerKey cleared on disk",
    persistedSettings(settingsDir).providerUrl === "" && persistedSettings(settingsDir).providerKey === "",
    `${JSON.stringify(persistedSettings(settingsDir).providerUrl)}/${JSON.stringify(persistedSettings(settingsDir).providerKey)}`,
  );

  // ── 12. status + listing surfaces ────────────────────────────────────────────
  rmSync(join(settingsDir, "settings.json"), { force: true });
  writeKeys("GROQ_API_KEY=gsk\n");
  const models = listFreeModels();
  check("listFreeModels returns the whole catalog", models.length === CATALOG.models.length && models.length > 50);
  check("listFreeModels marks a keyless model available", models.some((m) => m.available && providerById(m.platform)?.keyless));
  const status = freeStatus();
  check("freeStatus reports every provider", status.providers.length === 23);
  check("freeStatus strategy is valid + catalog version present", getFreeStrategy() === status.strategy && !!status.catalogVersion);
  const groqStatus = status.providers.find((p) => p.id === "groq");
  check("freeStatus flags the keyed provider as hasKey", !!groqStatus?.hasKey && groqStatus.availableCount > 0);

  // ── 13. usage passthrough + free turns are unpriced ($0) ─────────────────────
  freshState();
  writeKeys("GROQ_API_KEY=gsk\n");
  const usageStub = async (o: CallOpts): Promise<ModelResponse> => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "hello" }],
    usage: { input_tokens: 10_100, output_tokens: 57 },
    model: o.model,
  });
  const respU = await callFree(makeOpts("auto"), usageStub);
  check(
    "usage passthrough: callFree/postProcess keeps real output_tokens (never zeroes them)",
    respU.usage?.output_tokens === 57 && respU.usage?.input_tokens === 10_100,
    JSON.stringify(respU.usage),
  );
  // A free-router turn is $0 even when its resolved id regex-matches a PRICED frontier family in MODELS[]
  // (the "~$0.0034" phantom): turnCost gates on the ROUTE, not the model id.
  const servedFree = respU.model ?? "google/gemini-3-flash-preview";
  check("free turn is unpriced ($0) via turnCost", turnCost("free", servedFree, 10_100, 500) === 0, String(turnCost("free", servedFree, 10_100, 500)));
  check(
    "the same free id WOULD price on a billed route (proves the phantom was real)",
    costForUsage("google/gemini-3-flash-preview", 10_100, 500) > 0,
  );
}

run()
  .catch((e) => {
    console.error("smoke crashed:", e);
    fail = true;
  })
  .finally(() => {
    process.chdir(origCwd);
    process.env = savedEnv;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    console.log("");
    if (fail) {
      console.error("✗ free-router smoke FAILED");
      process.exit(1);
    }
    console.log("✓ free-router smoke passed");
    process.exit(0);
  });

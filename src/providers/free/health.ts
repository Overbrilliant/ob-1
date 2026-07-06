// Key health for the embedded free-models router. Validates each KEYED provider's key with a GET /models
// probe (reusing profiles.ts fetchModels, which never throws) and records the verdict in router state:
//   • 401/403        ⇒ auth failure; 3 consecutive ⇒ the provider is DISABLED until the key CHANGES
//                       (a key-hash change resets the counter and re-opens it);
//   • transport error ⇒ status "error", does NOT count toward disable (the provider may just be unreachable);
//   • otherwise ok    ⇒ "healthy", counter reset.
// Keyless providers are healthy-by-default (never probed). ALL of this is BACKGROUND + non-blocking — a
// health probe must never delay a user turn (callFree gates on stored state only).
import { fetchModels, type ConnResult } from "../profiles.ts";
import { FREE_PROVIDERS, resolveConnection } from "./registry.ts";
import { getHealth, keyHash, setHealth, type HealthStatus } from "./state.ts";
import { loadKeys } from "./keys.ts";

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // periodic re-check cadence
const STALE_MS = 15 * 60 * 1000; // lazy re-check threshold on first use
const CONSECUTIVE_FAILS_TO_DISABLE = 3;

type Prober = (baseUrl: string, apiKey: string) => Promise<ConnResult>;

let loopStarted = false;
let running = false;
let lastKickAt = 0;

/** Background health work is disabled (tests / offline smokes) when OB1_FREE_DISABLE_BG is truthy. */
function bgDisabled(): boolean {
  return /^(1|true|on)$/i.test(process.env.OB1_FREE_DISABLE_BG ?? "");
}

/** Validate every keyed provider whose stored health is stale (or when `force`). Keyless providers are
 *  skipped (healthy-by-default). Never throws — each probe result is folded into state. Injectable `_probe`
 *  (defaults to fetchModels) so the offline smoke can drive it without network. */
export async function runFreeHealthCheck(force = false, _probe: Prober = fetchModels): Promise<void> {
  if (running) return; // one probe pass at a time
  running = true;
  try {
    const keys = loadKeys();
    const now = Date.now();
    for (const provider of FREE_PROVIDERS) {
      if (provider.keyless) continue; // healthy-by-default; never probed
      const key = keys.byProvider.get(provider.id);
      if (!key) continue; // no active key → nothing to validate
      const prev = getHealth(provider.id);
      const hash = keyHash(key);
      const keyChanged = !prev || prev.keyHash !== hash;
      // Key change resets the auth-fail counter and re-opens a disabled provider (status → unknown) before
      // re-validating in the background.
      if (keyChanged)
        setHealth(provider.id, { status: "unknown", consecutiveAuthFails: 0, keyHash: hash, lastCheckedAt: 0 });
      const stale = keyChanged || force || !prev || now - prev.lastCheckedAt > CHECK_INTERVAL_MS;
      if (!stale) continue;

      const conn = resolveConnection(provider, key);
      const result = await _probe(conn.baseUrl, conn.apiKey);
      const base = getHealth(provider.id);
      if (result.ok) {
        setHealth(provider.id, {
          status: "healthy",
          consecutiveAuthFails: 0,
          keyHash: hash,
          lastCheckedAt: Date.now(),
        });
      } else if (result.status === 401 || result.status === 403) {
        const fails = (base?.consecutiveAuthFails ?? 0) + 1;
        const status: HealthStatus = fails >= CONSECUTIVE_FAILS_TO_DISABLE ? "disabled" : "invalid";
        setHealth(provider.id, { status, consecutiveAuthFails: fails, keyHash: hash, lastCheckedAt: Date.now() });
      } else {
        // Transport error / unexpected non-2xx (e.g. a provider whose /models 404s): mark "error" WITHOUT
        // counting toward disable. "error" does not gate routing — chat may still work.
        setHealth(provider.id, { status: "error", keyHash: hash, lastCheckedAt: Date.now() });
      }
    }
  } finally {
    running = false;
  }
}

/** Start the periodic (10-min) background re-check. Idempotent; the interval is unref'd so it never keeps
 *  the process alive. No-op when background work is disabled. */
export function startHealthLoop(): void {
  if (loopStarted || bgDisabled()) return;
  loopStarted = true;
  const timer = setInterval(() => {
    void runFreeHealthCheck().catch(() => {});
  }, CHECK_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** Fire a health pass in the BACKGROUND (never awaited) when a keyed provider is stale > 15 min or health
 *  hasn't run recently. Debounced so it can be called from the hot path cheaply. No-op when bg is disabled. */
export function kickHealthIfStale(): void {
  if (bgDisabled() || running) return;
  const now = Date.now();
  if (now - lastKickAt < STALE_MS) return;
  const keys = loadKeys();
  let due = false;
  for (const provider of FREE_PROVIDERS) {
    if (provider.keyless || !keys.byProvider.get(provider.id)) continue;
    const h = getHealth(provider.id);
    if (!h || now - h.lastCheckedAt > STALE_MS) {
      due = true;
      break;
    }
  }
  if (!due) return;
  lastKickAt = now;
  void runFreeHealthCheck().catch(() => {});
}

/** Fire an immediate background validation (e.g. right after the keys file changed). No-op when disabled. */
export function kickHealthNow(): void {
  if (bgDisabled()) return;
  lastKickAt = Date.now();
  void runFreeHealthCheck().catch(() => {});
}

/** Reset the loop/debounce guards (tests only). */
export function resetHealthRuntime(): void {
  loopStarted = false;
  running = false;
  lastKickAt = 0;
}

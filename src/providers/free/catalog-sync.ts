import { createPublicKey, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { loadAuthToken, ob1ServerUrl } from "../../config.ts";
import {
  currentCatalog,
  isCatalog,
  readCachedCatalog,
  setActiveCatalog,
  resetActiveCatalog,
  writeCachedCatalog,
} from "./catalog-store.ts";
import type { Catalog } from "./registry.ts";

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----`;

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTH_SYNC_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const publicKey = createPublicKey(PUBLIC_KEY_PEM);

let lastAttemptAt = 0;
let lastAuthState = "";
let inFlight: Promise<void> | null = null;
let syncLoop: ReturnType<typeof setInterval> | undefined;

function disabled(): boolean {
  return process.env.OB1_FREE_CATALOG_SYNC_DISABLED === "1" || process.env.OB1_FREE_DISABLE_BG === "1";
}

function unsignedAllowed(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.OB1_FREE_CATALOG_ALLOW_UNSIGNED ?? "");
}

function verifySignature(bytes: Uint8Array, signature: string | null): boolean {
  if (unsignedAllowed()) return true;
  if (!signature) return false;
  try {
    return verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function cachedMonthlyFallback(): void {
  const monthly = readCachedCatalog("monthly");
  if (monthly) setActiveCatalog(monthly);
  else resetActiveCatalog();
}

async function doSync(force: boolean): Promise<void> {
  if (disabled()) return;
  const token = loadAuthToken();
  const authState = token ? "auth" : "anon";
  const now = Date.now();
  const interval = token ? AUTH_SYNC_INTERVAL_MS : SYNC_INTERVAL_MS;
  if (!force && lastAuthState === authState && lastAttemptAt && now - lastAttemptAt < interval) return;
  lastAttemptAt = now;
  lastAuthState = authState;

  if (!token) cachedMonthlyFallback();

  const active = currentCatalog();
  const url = new URL(`${ob1ServerUrl()}/v1/free-catalog/latest`);
  if (active.version) url.searchParams.set("since", active.version);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return;
  }
  if (res.status === 304) return;
  if (!res.ok) return;

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!verifySignature(bytes, res.headers.get("x-catalog-signature"))) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return;
  }
  if (!isCatalog(parsed)) return;

  const catalog = parsed as Catalog;
  writeCachedCatalog(catalog);
  setActiveCatalog(catalog);
}

export async function syncFreeCatalogIfStale(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doSync(!!opts.force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function kickFreeCatalogSync(): void {
  void syncFreeCatalogIfStale();
}

export function startFreeCatalogSyncLoop(intervalMs = SYNC_INTERVAL_MS): void {
  if (syncLoop || disabled()) return;
  kickFreeCatalogSync();
  syncLoop = setInterval(() => {
    void syncFreeCatalogIfStale({ force: true });
  }, intervalMs);
  syncLoop.unref?.();
}

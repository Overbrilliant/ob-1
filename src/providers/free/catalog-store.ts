import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalSettingsDir } from "../../config.ts";
import { CATALOG, type Catalog, type CatalogModel } from "./registry.ts";

export type CatalogTier = "monthly" | "live" | string;

let activeCatalog: Catalog = CATALOG;

export function currentCatalog(): Catalog {
  return activeCatalog;
}

export function setActiveCatalog(catalog: Catalog): void {
  activeCatalog = catalog;
}

export function resetActiveCatalog(): void {
  activeCatalog = CATALOG;
}

export function catalogCachePath(tier: CatalogTier, settingsDir = globalSettingsDir()): string {
  const safe = tier.replace(/[^a-z0-9_.-]+/gi, "_").toLowerCase() || "monthly";
  return join(settingsDir, `free-catalog.${safe}.json`);
}

function isCatalogModel(v: unknown): v is CatalogModel {
  const m = v as Partial<CatalogModel>;
  return !!m && typeof m.platform === "string" && typeof m.modelId === "string" && typeof m.displayName === "string"
    && typeof m.intelligenceRank === "number" && typeof m.speedRank === "number" && typeof m.enabled === "boolean";
}

export function isCatalog(v: unknown): v is Catalog {
  const c = v as Partial<Catalog>;
  return !!c && typeof c.version === "string" && typeof c.generatedAt === "string" && typeof c.tier === "string"
    && Array.isArray(c.platforms) && Array.isArray(c.models) && c.models.every(isCatalogModel);
}

export function readCachedCatalog(tier: CatalogTier, settingsDir = globalSettingsDir()): Catalog | null {
  try {
    const parsed = JSON.parse(readFileSync(catalogCachePath(tier, settingsDir), "utf8"));
    return isCatalog(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedCatalog(catalog: Catalog, settingsDir = globalSettingsDir()): void {
  const path = catalogCachePath(catalog.tier || "monthly", settingsDir);
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(catalog, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* permissions are best-effort on non-POSIX filesystems */
  }
}

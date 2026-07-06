// Dev-time catalog sync: vendor the freellmapi-suite live catalog into src/providers/free/catalog.json,
// FILTERED for the embedded router. NOT run at runtime — the compiled binary reads the vendored JSON.
//
// Filters (see the free-router design spec):
//   • drop media models (modality "image" / "audio") — the router is chat-only;
//   • drop the `aihorde` platform + all its models (queue-based, no streaming);
//   • drop any model whose platform is not in FREE_PROVIDERS (warn) — the registry is the source of truth;
//   • KEEP `enabled:false` rows (the flag is respected at gating time, not filtered here);
//   • KEEP quirks (per-model + top-level, minus quirks that only target dropped platforms).
//
// Usage:  bun scripts/sync-free-catalog.ts
// Source: ../../freellmapi-suite/catalog/data/catalog.live.json (override with OB1_CATALOG_SRC).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FREE_PROVIDERS, type Catalog, type CatalogModel } from "../src/providers/free/registry.ts";

const scriptsDir = dirname(Bun.fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..");
const DEST = join(repoRoot, "src/providers/free/catalog.json");
const SRC =
  process.env.OB1_CATALOG_SRC ?? join(repoRoot, "..", "..", "freellmapi-suite", "catalog", "data", "catalog.live.json");

const DROP_PLATFORMS = new Set(["aihorde"]);
const DROP_MODALITIES = new Set(["image", "audio"]);
const KNOWN_PLATFORMS = new Set(FREE_PROVIDERS.map((p) => p.id));

function loadCurrent(): Catalog | null {
  try {
    return JSON.parse(readFileSync(DEST, "utf8")) as Catalog;
  } catch {
    return null;
  }
}

function main(): void {
  const raw = JSON.parse(readFileSync(SRC, "utf8")) as Catalog & { models: CatalogModel[] };
  const previous = loadCurrent();
  const prevIds = new Set((previous?.models ?? []).map((m) => `${m.platform}/${m.modelId}`));

  const kept: CatalogModel[] = [];
  const droppedMedia: string[] = [];
  const droppedAihorde: string[] = [];
  const droppedUnknown: string[] = [];

  for (const m of raw.models) {
    const id = `${m.platform}/${m.modelId}`;
    if (m.modality && DROP_MODALITIES.has(m.modality)) {
      droppedMedia.push(id);
      continue;
    }
    if (DROP_PLATFORMS.has(m.platform)) {
      droppedAihorde.push(id);
      continue;
    }
    if (!KNOWN_PLATFORMS.has(m.platform)) {
      droppedUnknown.push(id);
      continue;
    }
    kept.push(m);
  }

  const platforms = (raw.platforms ?? []).filter((p) => !DROP_PLATFORMS.has(p.id) && KNOWN_PLATFORMS.has(p.id));

  // Keep top-level quirks, but strip targets that point at a dropped platform; drop a quirk left with no
  // remaining target (per-model quirks on kept rows are preserved untouched by the model copy above).
  const quirks = (Array.isArray(raw.quirks) ? raw.quirks : [])
    .map((q: any) => {
      if (!Array.isArray(q?.targets)) return q;
      const targets = q.targets.filter(
        (t: any) => !DROP_PLATFORMS.has(t?.platform) && (t?.platform == null || KNOWN_PLATFORMS.has(t.platform)),
      );
      return { ...q, targets };
    })
    .filter((q: any) => !Array.isArray(q?.targets) || q.targets.length > 0);

  const platformIds = new Set(kept.map((m) => m.platform));
  const out: Catalog = {
    version: raw.version,
    generatedAt: raw.generatedAt,
    tier: raw.tier,
    counts: {
      platforms: platformIds.size,
      models: kept.length,
      enabledModels: kept.filter((m) => m.enabled).length,
      quirks: quirks.length,
    },
    platforms,
    models: kept,
    quirks,
  };

  writeFileSync(DEST, JSON.stringify(out, null, 2) + "\n");

  // ── summary + diff ──
  const keptIds = new Set(kept.map((m) => `${m.platform}/${m.modelId}`));
  const added = [...keptIds].filter((id) => !prevIds.has(id));
  const removed = [...prevIds].filter((id) => !keptIds.has(id));

  console.log(`sync-free-catalog: ${SRC}`);
  console.log(`  source version : ${raw.version} (${raw.models.length} models)`);
  console.log(
    `  kept           : ${kept.length} models across ${platformIds.size} providers (${out.counts.enabledModels} enabled)`,
  );
  console.log(`  dropped media  : ${droppedMedia.length}${droppedMedia.length ? ` (${droppedMedia.join(", ")})` : ""}`);
  console.log(`  dropped aihorde: ${droppedAihorde.length}`);
  if (droppedUnknown.length)
    console.log(`  ⚠ dropped unknown platform(s): ${droppedUnknown.length} (${droppedUnknown.join(", ")})`);
  console.log(`  quirks kept    : ${quirks.length}`);
  if (previous) {
    console.log(`  diff vs current: +${added.length} / -${removed.length}`);
    if (added.length) console.log(`    added  : ${added.join(", ")}`);
    if (removed.length) console.log(`    removed: ${removed.join(", ")}`);
  } else {
    console.log(`  (no previous catalog to diff against)`);
  }
  console.log(`  wrote ${DEST}`);

  // Cross-check: every kept platform must exist in FREE_PROVIDERS (should always hold post-filter).
  const missingRegistry = [...platformIds].filter((p) => !KNOWN_PLATFORMS.has(p));
  if (missingRegistry.length) {
    console.error(`  ✗ platforms in catalog but missing from FREE_PROVIDERS: ${missingRegistry.join(", ")}`);
    process.exit(1);
  }
  // Inverse warning: registered providers with zero catalog models (informational — keyless providers may
  // legitimately have models; a keyed provider with none just contributes no routes).
  const withModels = new Set([...platformIds]);
  const idle = FREE_PROVIDERS.filter((p) => !withModels.has(p.id)).map((p) => p.id);
  if (idle.length) console.log(`  note: providers with no catalog models: ${idle.join(", ")}`);
}

main();

// Run the SAME Apple-page prompt through each ob1 mode → apple-pages/<mode>.html for head-to-head.
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { makeEmbedder } from "../src/memory/embed.ts";
import { runSolo } from "../src/eval/runners.ts";
import { runFusion, extractCode } from "../src/multimind/fusion.ts";
import { runCouncil } from "../src/multimind/council.ts";
import { runPersonas } from "../src/multimind/personas.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const cfg = loadConfig();
if (!cfg.apiKey && !cfg.providerProfile) { console.error("need a configured model route: sign in, or use /models for FreeLLMAPI or Custom API"); process.exit(1); }
const store = new MemoryStore(cfg.dbPath, makeEmbedder());
const tools = new Map(); // pure design task — no codebase tools needed
// Single model across ALL four modes → the only variable is the topology, not the model (R5/plan).
console.error(`model: ${cfg.model} (single model for all modes)\n`);

const BRIEF =
  "Build a COMPLETE, self-contained, single-file HTML page (inline <style> and <script>, NO build step, NO external " +
  "JS libraries) for the iPhone 17 Pro in authentic Apple.com design language: system font stack; huge bold clamp() " +
  "headlines; sticky frosted-glass nav (backdrop-filter blur) with minimal links + a blue pill CTA; a full-bleed hero " +
  "with the product name in massive type, a tagline, and 'Learn more ›' / 'Buy ›' links in Apple blue (#0071e3); " +
  "ALTERNATING black and white full-width feature sections, each with a big headline, short copy, and product visuals " +
  "built from CSS/SVG/gradients (draw the triple-camera module in CSS; no external images needed); scroll-reveal " +
  "animations via IntersectionObserver; a specs strip; and an authentic Apple fine-print footer with link columns. " +
  "Fully responsive, premium motion polish. Output ONLY the complete HTML document as a single fenced ```html code block.";

const dir = join(cfg.cwd, "apple-pages");
mkdirSync(dir, { recursive: true });
// Save the page, then open it in the default browser (new tab) as soon as it's created.
const save = (mode: string, text: string, inT: number, outT: number) => {
  const { code } = extractCode(text);
  const html = (code || text).trim();
  const path = join(dir, `${mode}.html`);
  writeFileSync(path, html);
  console.log(`✓ ${mode}.html  (${html.length.toLocaleString()} chars · ~${(inT + outT).toLocaleString()} tok) — opening…`);
  Bun.spawn(["open", path]); // macOS: opens file:// in the default browser as a new tab
};

console.error("→ solo (one model, one pass)…");
const solo = await runSolo(BRIEF, cfg, tools); save("solo", solo.text, solo.inputTokens, solo.outputTokens);
console.error("→ fusion (best-of-N, same prompt → judge merges the best parts)…");
const fu = await runFusion({ task: BRIEF, cfg, tools }); save("fusion", fu.synthesis, fu.totalInputTokens, fu.totalOutputTokens);
console.error("→ council (author ↔ reviewer revise rounds → comprehensive finalizer)…");
const co = await runCouncil({ task: BRIEF, cfg, tools }); save("council", co.final, co.totalInputTokens, co.totalOutputTokens);
console.error("→ personas (expert panel dialogue → facilitator finalizes)…");
const pe = await runPersonas({ task: BRIEF, cfg, tools }); save("personas", pe.final, pe.totalInputTokens, pe.totalOutputTokens);

store.close();
console.log("\ndone — solo.html / fusion.html / council.html / personas.html (all opened in your browser)");

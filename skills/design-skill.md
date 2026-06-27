---
name: design-skill
description: Comprehensive UI design system — plan a grounded token system, build foundations, components, and states, then review across breakpoints
---

# Design Skill

The complete UI/frontend design playbook for ob1 — load this whenever you design or build any user interface.

It is one continuous flow: **orchestration → foundations → components & states → behavior & quality → patterns → review.** Always begin with **Frontend Design** (the two-pass method: plan a grounded token system, critique it, *then* code), then pull in the sections you need. Cross-references like "the **color-system** section" point to headings below; this file is fully self-contained.

## Sections
1. **Frontend Design** — `frontend-design`
2. **Anti-Slop** — `anti-slop`
3. **Visual Hierarchy** — `visual-hierarchy`
4. **Design Tokens** — `design-tokens`
5. **Color System** — `color-system`
6. **Typography** — `typography`
7. **Spacing & Layout** — `spacing-and-layout`
8. **Depth & Imagery** — `depth-and-imagery`
9. **Component States** — `component-states`
10. **Loading, Empty & Error States** — `loading-empty-error-states`
11. **Forms & Inputs** — `forms-and-inputs`
12. **Data Tables** — `data-tables`
13. **Motion & Animation** — `motion-and-animation`
14. **Accessibility** — `accessibility`
15. **Responsive Design** — `responsive-design`
16. **Tailwind v4 + shadcn/ui** — `tailwind-and-shadcn`
17. **Landing Page Design** — `landing-page-design`
18. **Dashboard Design** — `dashboard-design`
19. **Screenshot Critique Loop** — `screenshot-critique-loop`
20. **Design Review** — `design-review`

## Frontend Design

Entry point for any "build/design a UI" request. **Never start coding immediately.** Run two passes:
plan (no code) → critique (kill clichés) → build. Ground every choice in the subject's real-world
domain — a tax app is not a candy app. Spend boldness in ONE place; keep the surroundings quiet.
When in doubt, remove one accessory.

### Pass 1 — Plan (no markup yet)
Invent a compact token system and show it to the user BEFORE writing any HTML/JSX. Five parts:

1. **Color** — 4-6 named hex tokens, derived from the subject. e.g. for a fishing-trip planner:
   `--deep:#0B3C5D --tide:#328CC1 --sand:#F4E4C1 --hull:#1C1C1C --coral:#E84A27`.
   One accent only. Defer ratios/scales to the **color-system** section.
2. **Type triad** — name 3 real fonts with roles + sizes:
   display (e.g. `Fraunces 700, 48px/52px`), body (`Inter 400, 16px/26px`),
   utility (`IBM Plex Mono 500, 13px`). Defer scale to the **typography** section.
3. **Spacing** — one 8pt scale: `4 8 12 16 24 32 48 64 96`. Pick the page gutter (e.g. `24`) and
   the section rhythm (e.g. `64`). Defer to the **spacing-and-layout** section.
4. **Wireframe** — ASCII the layout so structure is argued before pixels:
   ```
   ┌──────────────────────────────┐
   │ logo      nav        [CTA]    │  56px bar
   ├──────────────────────────────┤
   │  H1 display                   │
   │  sub · body                   │  hero, 64 pad
   │  [signature element]          │
   ├───────────────┬──────────────┤
   │ card          │ card         │  3-up @ ≥1024
   └───────────────┴──────────────┘
   ```
5. **Signature element** — ONE memorable thing tied to the domain (a tide-line divider, a boarding-pass
   ticket stub, a ledger rule). Everything else stays calm. Describe it in one sentence.

Output Pass 1 as a short spec block. Do not write components yet.

### Pass 2 — Critique, then build
Before coding, attack your own plan against the brief:
- [ ] Does each token trace to the subject, or is it a default? Replace defaults.
- [ ] Run the plan through the **anti-slop** section — delete generic gradients, glassmorphism, emoji
      bullets, "Lorem", purple-on-white SaaS look, centered everything.
- [ ] Is boldness concentrated in exactly one place? If two things shout, mute one.
- [ ] Is contrast deliberate (size, weight, color, space) — not a safe uniform gray?
- [ ] Real content, real numbers, real copy. No placeholder filler.

Then build with `write_file` / `edit_file`. As you implement, pull depth from siblings:

| Need | Skill |
|---|---|
| Color ramps, states, contrast pairs | the **color-system** section |
| Type scale, measure, leading | the **typography** section |
| Grid, gutters, density | the **spacing-and-layout** section |
| Hierarchy / focal order | the **visual-hierarchy** section |
| Transitions, easing, duration | the **motion-and-animation** section |
| Contrast, focus, labels, roles | the **accessibility** section |
| Breakpoints, fluid sizing | the **responsive-design** section |
| Tables, sorting, density | the **data-tables** section |
| Inputs, validation, layout | the **forms-and-inputs** section |
| hover/active/disabled/focus | the **component-states** section |
| skeletons, empty, error | the **loading-empty-error-states** section |
| Tailwind + shadcn patterns | the **tailwind-and-shadcn** section |
| Marketing pages | the **landing-page-design** section |
| Admin/metrics UIs | the **dashboard-design** section |
| Shadow, layering, imagery | the **depth-and-imagery** section |

### Verify (always close the loop)
1. Run the app (`run_bash`), then `browser_check` to navigate + screenshot at 375, 768, 1280px.
2. Critique the screenshot with the **screenshot-critique-loop** section; iterate until it matches the plan.
3. Final gate: the **design-review** section against the brief and tokens.
4. Use `diagnostics` to clear console/type errors before declaring done.

### Persist the system
Write the chosen tokens to `DESIGN.md` (colors, fonts, spacing, signature) via the **design-tokens** section
so the next session reuses them instead of reinventing. Record one-line rationale per token. Drop a
durable note with `memory_add` if the project has a standing design language.

### Do / Don't
- DO derive 4-6 colors from the subject; DON'T ship the framework's default palette.
- DO let one element be loud; DON'T make three things compete.
- DO show the plan first; DON'T emit markup in Pass 1.
- DO use real copy and numbers; DON'T leave Lorem or `#`-href stubs.
- DO verify with a screenshot; DON'T trust the DOM you can't see.

---

## Anti-Slop

The catalog of AI-generated design tells to kill on sight, each with the fix. Generic is death:
"clean and modern" is the smell of every default. Read this before writing UI, screenshot
after with `browser_check`, and run the checklist before declaring done.

### Rule 0 — Commit to ONE named aesthetic
Don't → ship an unnamed "modern, clean" blur that averages every template.
Do → pick ONE direction and commit every token to it. Confirm with the user before coding.
Pick from (or name your own): `editorial-minimal`, `terminal-core`, `warm-editorial`,
`data-dense-pro`, `cinematic-dark`, `neo-brutalist`. State it in one sentence, then make
type, color, spacing, and motion all serve it. See the **frontend-design** section.

### Fonts — banned as the unconsidered default
Don't → reach for Inter / Roboto / Open Sans / Lato / `system-ui` because they're there.
Do → choose a family that carries the chosen tone; ≥1 distinctive face (display or text).
These 5 are fine ~10% of the time when *deliberate*, never as the reflex. Pair display + text
with real contrast. Details: the **typography** section.

### Banned visual clichés (each with the fix)
Don't → purple→indigo gradient on white.
Do → a flat brand color with ≥4.5:1 text contrast; gradients only with intent. the **color-system** section.

Don't → three equal rounded cards in a row.
Do → asymmetry — vary span/size by importance; lead with one hero item, not 3 clones.

Don't → center everything in the hero (text, buttons, image all stacked mid-axis).
Do → a real grid; left-align long text; let one strong element anchor the layout. the **spacing-and-layout** section.

Don't → a `0 1px 2px rgba(0,0,0,.1)` drop shadow on every box.
Do → ≤2 elevation levels with intent; prefer borders/contrast over universal soft shadow. the **depth-and-imagery** section.

Don't → emoji as section or feature icons (🚀 ✨ 🔥).
Do → a real icon set (Lucide/Phosphor/custom SVG) at one consistent stroke weight.

Don't → frosted glassmorphism cards by default (`backdrop-blur` + white@10%).
Do → use blur only where layering is real and earns it; otherwise solid surfaces.

Don't → rainbow / 3+-stop multi-hue gradients.
Do → ≤2 stops within one hue family, or a single solid.

Don't → Tailwind `blue-500` as "the brand."
Do → define brand tokens; never let a framework default stand in for an identity.

Don't → `border-radius` the same value on everything (or none with no reason).
Do → 1–2 radius tokens chosen for the aesthetic (sharp for brutalist, soft for warm).

Don't → leave "Lorem ipsum", "Card Title", or `[placeholder]` copy in.
Do → write real, specific copy in the product's voice before screenshotting.

### Banned named combinations (canon clichés)
- cream background + serif body + terracotta accent — the "AI warm-editorial" stock skin.
- near-black + acid/neon-green (`#0a0a0a` + `#39ff14`) — the default "hacker" costume.
- broadsheet hairline-rules newspaper layout on what is actually a web app — rules ≠ editorial.
Avoid these specific triples unless the brand genuinely demands them and you push past the stock version.

### Gut checks (before you call it done)
- Squint test: blur the screenshot 8px — does hierarchy still read? If everything's equal weight, fail.
- Would a senior product designer ship this, or is it a template with the logo swapped?
- Does it look like *this subject*, or like every other AI page? Name one thing only this product would have.

### Verify
1. Build, then `browser_check` to screenshot the rendered page (real fonts, real spacing).
2. Scan the screenshot against every Don't above; list each tell you spot.
3. Fix, re-screenshot, repeat. For the full iterate-on-pixels loop, the **screenshot-critique-loop** section.

### Pass/fail checklist (run before declaring a UI done)
- [ ] One named aesthetic stated and consistently applied.
- [ ] No Inter/Roboto/Open Sans/Lato/system-ui as an unconsidered default.
- [ ] No purple/indigo-on-white gradient; no rainbow gradient; no Tailwind-blue-500 brand.
- [ ] Not three equal cards; not centered-everything; layout uses a real grid with asymmetry.
- [ ] ≤2 elevation levels; no universal 0.1-opacity shadow.
- [ ] Real icons, not emoji; glassmorphism only where layering is real.
- [ ] 1–2 intentional radius tokens; no accidental uniformity.
- [ ] Zero placeholder copy; all text real and on-voice.
- [ ] None of the banned named combinations in their stock form.
- [ ] Passes the squint test and the "would a senior designer ship this" test.
- [ ] `browser_check` screenshot taken and scanned against this list.

---

## Visual Hierarchy

Every view answers one question in under 1 second: where do I look first? If two elements compete, you have no hierarchy. Decide the single dominant element, then rank the rest. Pair with the **typography** section for scale, the **color-system** section for accent, the **spacing-and-layout** section for whitespace.

### One focal point per view

Pick the ONE element that earns the most attention — the hero claim, the primary CTA, the key number. Everything else is secondary or tertiary.

- [ ] Name the single primary element before styling anything
- [ ] Primary : secondary : tertiary — assign every block one of 3 tiers, no fourth
- [ ] Spend boldness in ONE place; keep the surrounding 80% quiet
- [ ] If you can't point to the focal point in 1s, you have 2+ competing — demote one

### The five levers of emphasis

Size · weight · color/contrast · whitespace · position. Each one spends attention. Combine 2–3 on the primary; never push all five on multiple elements.

- [ ] Primary: stack 2–3 levers (e.g. large + bold + accent color)
- [ ] Secondary: 1 lever, dialed down
- [ ] Tertiary: 0 levers — muted, small, default weight
- [ ] Don't fight yourself: emphasizing 5 things = emphasizing nothing

### Scale jumps — make them obvious

Levels must read instantly, not on inspection. Use ≥3× type-size jumps between hierarchy tiers, not timid 1.5×.

- [ ] Hero ≥ 3× body (64–96px hero vs 16px body), not 24px vs 16px
- [ ] Adjacent tiers differ ≥1.5×; primary-to-tertiary ≥3×
- [ ] Pair size with weight contrast (200/300 vs 700/800), see the **typography** section
- [ ] Squint: if two tiers look the same size, widen the gap

### Reading patterns — put weight on the hot spots

LTR eyes start top-left and scan predictably. Place key content where eyes already land.

- [ ] Text-dense pages → F-pattern: focal content top + left edge, strong first line
- [ ] Landing/marketing → Z-pattern: logo TL → nav TR → hero → CTA bottom-right
- [ ] Top-left bias: most important element in the top-left quadrant unless deliberately broken
- [ ] Never bury the primary CTA below the fold or in the dead bottom-left corner

### Contrast budget — one CTA per view

A view has a finite emphasis budget. Every bold/bright/large/spacious element draws from it. Overspend and nothing reads as primary.

- [ ] Exactly ONE primary CTA per view; rest are secondary (outline/ghost) or text links
- [ ] Count bold/bright/oversized elements — if >3 compete, cut or demote
- [ ] If everything shouts, nothing is heard — silence the secondary to amplify the primary

### Color for rank

Reserve the accent for the single most important action; rank everything else in neutrals. See the **color-system** section.

- [ ] Accent color used once per view — the primary action only
- [ ] Secondary actions: neutral/muted, never the accent
- [ ] Convey rank with value (light↔dark) before reaching for hue
- [ ] Body text and chrome stay low-contrast so the focal point pops

### Progressive disclosure

Show the 20% that matters; defer the rest. A flat wall of equal detail has no hierarchy.

- [ ] Surface primary content; hide secondary behind tabs / accordions / "show more"
- [ ] Reveal on demand: hover, expand, drill-in, detail panes
- [ ] Default view fits the core task on one screen without scrolling for the essentials
- [ ] Don't disclose so aggressively that the primary action gets hidden

### The squint test — verify hierarchy survives blur

Blur the screen and the hierarchy must still read: one dominant blob, clear second tier, quiet rest. Equal blobs = failed hierarchy.

- [ ] Screenshot the rendered view with `browser_check`
- [ ] Assess at a glance: does ONE region dominate? Can you find the CTA blurred?
- [ ] If all blobs look equal-weight → add levers to primary, strip them from the rest
- [ ] Re-shoot with `browser_check` after each fix until the focal point is unmistakable

### Output checklist

- [ ] Single focal point named and unambiguously dominant
- [ ] 3 tiers assigned; 2–3 levers on primary, ≤1 elsewhere
- [ ] ≥3× scale jump primary→tertiary
- [ ] Key content on F/Z hot spots, top-left bias respected
- [ ] One primary CTA; accent color used exactly once
- [ ] Secondary detail behind progressive disclosure
- [ ] Squint test passed via `browser_check` — hierarchy survives blur

---

## Design Tokens

You have no cross-session visual memory. A `DESIGN.md` at the repo root IS that memory: machine-readable
tokens plus the rules that govern them. Treat it as the single source of truth for every pixel.

### When to act
On any non-trivial UI work (new screen, component, theme, restyle):
- [ ] `read_file DESIGN.md` first (find it via `repo_map`). If it exists, **OBEY it** — pull tokens, never invent parallel ones.
- [ ] If absent and the work is non-trivial, author one with `write_file` **before or while** building. Don't ship UI with no recorded system.
- [ ] One-off copy tweak or bugfix? Skip this; don't gold-plate.

### DESIGN.md schema
YAML front-matter (the tokens a tool/agent can parse) + a markdown body (the 9 sections):
1. **Theme & atmosphere** — 1-2 lines: mood, domain, the one bold move.
2. **Color palette & roles** — bg/surface/text/muted/border/brand/accent/success/warn/danger, each a token.
3. **Typography rules** — families, scale, weights, line-height, measure.
4. **Component styling** — buttons/inputs/cards with every state: rest/hover/active/focus/disabled.
5. **Layout** — 8pt spacing scale + grid/gutter/max-width.
6. **Depth & elevation** — the 5-level shadow ramp and what sits on each.
7. **Do's & Don'ts** — token rules; e.g. "never hardcode hex/px".
8. **Responsive** — breakpoints + touch-target floor (≥44px).
9. **Agent prompt guide** — 3-5 lines telling the next session how to consume this file.

### Token construction (numeric, re-themeable)
Drive the whole palette from a single `--brand-hue` in **OKLCH** so the ramp is perceptually even and a rebrand is a one-line hue swap. Spacing on an **8pt scale**: `4 8 12 16 24 32 48 64`. A type scale (1.25 ratio), a radius scale, and a **5-level shadow ramp** (0=flat → 4=modal).

```css
:root {
  --brand-hue: 255;                                   /* swap this, re-theme everything */
  --bg:      oklch(0.99 0.01 var(--brand-hue));
  --surface: oklch(0.97 0.02 var(--brand-hue));
  --text:    oklch(0.22 0.03 var(--brand-hue));
  --muted:   oklch(0.52 0.03 var(--brand-hue));
  --border:  oklch(0.88 0.02 var(--brand-hue));
  --brand:   oklch(0.55 0.18 var(--brand-hue));
  --accent:  oklch(0.70 0.17 calc(var(--brand-hue) + 150));
  --on-brand:oklch(0.99 0.01 var(--brand-hue));
  /* spacing 8pt */ --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-6:24px; --s-8:32px; --s-12:48px; --s-16:64px;
  /* type 1.25 */  --fs-sm:.8rem; --fs-base:1rem; --fs-lg:1.25rem; --fs-xl:1.563rem; --fs-2xl:1.953rem; --fs-3xl:2.441rem;
  /* radius */     --r-sm:4px; --r-md:8px; --r-lg:16px; --r-full:9999px;
  /* shadow ramp */
  --shadow-0:none;
  --shadow-1:0 1px 2px oklch(0.2 0.03 var(--brand-hue)/.08);
  --shadow-2:0 2px 6px oklch(0.2 0.03 var(--brand-hue)/.10);
  --shadow-3:0 8px 24px oklch(0.2 0.03 var(--brand-hue)/.14);
  --shadow-4:0 24px 56px oklch(0.2 0.03 var(--brand-hue)/.22);
}
```

YAML equivalent for the DESIGN.md front-matter:

```yaml
---
brand_hue: 255
color:   { bg: "oklch(.99 .01 255)", surface: "oklch(.97 .02 255)", text: "oklch(.22 .03 255)",
           muted: "oklch(.52 .03 255)", border: "oklch(.88 .02 255)",
           brand: "oklch(.55 .18 255)", on_brand: "oklch(.99 .01 255)", accent: "oklch(.70 .17 45)" }
space:   [4, 8, 12, 16, 24, 32, 48, 64]   # 8pt scale
type:    { ratio: 1.25, base: 16, family_ui: "Inter", family_display: "Fraunces" }
radius:  { sm: 4, md: 8, lg: 16, full: 9999 }
shadow:  [none, "0 1px 2px /.08", "0 2px 6px /.10", "0 8px 24px /.14", "0 24px 56px /.22"]
breakpoints: { sm: 640, md: 768, lg: 1024, xl: 1280 }
touch_min: 44
---
```

### Validate contrast before shipping
Every text/background and UI/background pair must clear WCAG: **4.5:1** body text, **3:1** large text (≥24px or ≥19px bold) and UI/borders. List each pair and its ratio in DESIGN.md, e.g.:

- [ ] `text` on `bg` — 14.8:1 ✓ (body)
- [ ] `text` on `surface` — 13.1:1 ✓ (body)
- [ ] `muted` on `bg` — 4.9:1 ✓ (body)
- [ ] `on-brand` on `brand` — 6.2:1 ✓ (body)
- [ ] `border` on `bg` — 3.2:1 ✓ (UI)

Any pair below floor: lighten/darken the OKLCH **L** channel only (hue/chroma stay) and re-check. Defer ramp tuning to the **color-system** section.

### Export — reference, never hardcode
Map tokens to CSS variables (above) AND a Tailwind v4 `@theme` block so utilities resolve to the same tokens. Components reference `var(--…)` or the Tailwind alias — **zero literal hex/px in markup**.

```css
@theme {
  --color-bg: var(--bg); --color-surface: var(--surface); --color-text: var(--text);
  --color-brand: var(--brand); --color-accent: var(--accent);
  --spacing-4: var(--s-4); --radius-md: var(--r-md); --shadow-2: var(--shadow-2);
}
```

Wire-up details, shadcn theming, and `tailwind.config`/CSS layering: the **tailwind-and-shadcn** section.

### Close the loop
- [ ] Build referencing tokens only; grep the diff for raw `#` hex or `px` literals and replace with `var(--…)`.
- [ ] `run_bash` the app, `browser_check` at 375/768/1280 — confirm rendered colors match the OKLCH tokens.
- [ ] Defer palette construction to the **color-system** section, type scale/measure to the **typography** section, shadow/imagery depth to the **depth-and-imagery** section.
- [ ] `memory_add` a one-line pointer: "DESIGN.md exists at repo root — read and obey it for all UI work" so future sessions find the system instead of reinventing it.

### Do / Don't
- DO drive the palette from one `--brand-hue`; DON'T scatter unrelated hex values.
- DO record every contrast ratio; DON'T ship a pair you haven't measured.
- DO reference tokens in components; DON'T inline hex or px.
- DO update DESIGN.md when a token changes; DON'T let code and the file drift apart.

---

## Color System

Build palettes from roles, not vibes. ONE dominant brand color + ONE sharp accent + ONE neutral ramp. Everything else is semantic. Emit tokens with `write_file`, verify rendering with `browser_check`.

### Structure

- ONE dominant brand hue. ONE accent hue, 30-90 degrees off it for tension. Not two brands.
- Neutral tonal ramp: 9-12 steps (50, 100...900, optionally 950). Tint the neutral 2-4% chroma toward the brand hue so grays feel intentional, not dead.
- Apply 60/30/10: 60% neutral surfaces, 30% dominant, 10% accent. Accent is for ONE call-to-action per view, not decoration.
- Components reference role tokens ONLY, never raw hex. See the **design-tokens** section.

### Semantic roles (name every one)

- `background` `surface` `surface-raised` `border`
- `text` `text-muted`
- `primary` `primary-foreground`
- `destructive` `success` `warning` `info`
- `ring` (focus outline)

Each role maps to a ramp step, not a literal. Re-theme by editing 1 hue, not 40 hex values.

### OKLCH ramps

Use OKLCH: `oklch(L C H)`, L 0-1, C ~0-0.37, H 0-360. Perceptually even — fix C and H, step L linearly and lightness reads uniform.

HSL pitfall: equal HSL lightness deltas are NOT equal perceived lightness (yellow at 50% L looks far brighter than blue at 50% L). Never build ramps in HSL.

```css
/* Brand ramp, one hue (262), even L steps, gentle chroma arc */
--brand-50:  oklch(0.97 0.02 262);
--brand-100: oklch(0.93 0.04 262);
--brand-200: oklch(0.86 0.07 262);
--brand-300: oklch(0.78 0.10 262);
--brand-400: oklch(0.69 0.13 262);
--brand-500: oklch(0.60 0.15 262); /* base */
--brand-600: oklch(0.52 0.14 262);
--brand-700: oklch(0.44 0.12 262);
--brand-800: oklch(0.36 0.09 262);
--brand-900: oklch(0.28 0.06 262);
```

Generate algorithmically with `run_bash` for consistency across 10+ steps; don't hand-pick.

### Dark mode

Do NOT invert. Build dark as a separate desaturated tonal set mapping the SAME roles.

- Background ~12-16% L. NEVER pure-black `#000` — it kills depth and vibrates against text.
- Body text ~90% L. NEVER pure-white `#fff` — too harsh; halos on dark.
- Elevation = RAISE lightness: `surface` lighter than `background`, `surface-raised` lighter still. No drop shadows for depth on dark; the **depth-and-imagery** section.
- Lower chroma ~15-30% vs light mode; saturated colors glow and smear on dark.

### Contrast (WCAG)

Enforce minimums; defer full sweep to the **accessibility** section.

- Body text: >= 4.5:1
- Large text (>=24px or >=18.66px bold): >= 3:1
- UI components, borders, focus rings: >= 3:1

| Pair (light) | Ratio | Use |
|---|---|---|
| text on background | ~16:1 | body |
| text-muted on background | ~4.8:1 | captions |
| primary-foreground on primary | ~7:1 | buttons |
| border on background | ~3.2:1 | dividers |

Never convey meaning by color alone — pair status color with icon + label. the **typography** section for text sizing thresholds.

### Avoid (see the **anti-slop** section)

- Default Tailwind `blue-500` as "brand". Pick a hue.
- Purple-to-blue gradient on white. Dead on arrival.
- Pure black/white filling large surfaces.
- Rainbow / multi-hue gradients. Stay within one hue family.

### Checklist

- [ ] One brand hue + one accent (30-90 deg apart)
- [ ] Neutral ramp 9-12 steps, slight brand tint
- [ ] All 13 semantic roles defined for light AND dark
- [ ] Ramps authored in OKLCH, even L steps
- [ ] Dark mode rebuilt, not inverted; bg 12-16% L, text ~90% L
- [ ] Chroma reduced in dark mode
- [ ] Every text/bg pair meets 4.5:1 (or 3:1 large/UI)
- [ ] No raw hex in components — roles only
- [ ] No blue-500 / purple gradient / pure b&w clichés
- [ ] Verified in browser_check, light + dark

### Token output

```css
:root {
  --background: oklch(0.99 0.00 262);
  --surface: oklch(0.97 0.01 262);
  --surface-raised: oklch(1.00 0.00 262);
  --border: oklch(0.90 0.01 262);
  --text: oklch(0.20 0.02 262);
  --text-muted: oklch(0.52 0.02 262);
  --primary: oklch(0.60 0.15 262);
  --primary-foreground: oklch(0.99 0.00 262);
  --destructive: oklch(0.58 0.18 27);
  --success: oklch(0.62 0.14 150);
  --warning: oklch(0.75 0.15 80);
  --info: oklch(0.65 0.12 230);
  --ring: oklch(0.60 0.15 262);
}
:root[data-theme="dark"] {
  --background: oklch(0.15 0.01 262);
  --surface: oklch(0.19 0.01 262);
  --surface-raised: oklch(0.23 0.02 262);
  --border: oklch(0.30 0.02 262);
  --text: oklch(0.90 0.01 262);
  --text-muted: oklch(0.68 0.02 262);
  --primary: oklch(0.66 0.13 262);
  --primary-foreground: oklch(0.16 0.01 262);
  --destructive: oklch(0.64 0.15 27);
  --success: oklch(0.68 0.11 150);
  --warning: oklch(0.78 0.12 80);
  --info: oklch(0.70 0.10 230);
  --ring: oklch(0.66 0.13 262);
}
```

---

## Typography

Type carries 90% of an interface. Get the typeface, scale, and rhythm right before touching anything else. Pair with the **visual-hierarchy** section and the **spacing-and-layout** section; defer all color to the **color-system** section.

### Pick the typeface by tone

Max TWO families: one display + one text. Add a mono ONLY for code. Never reach for Inter/Roboto/Open Sans/Lato/system as the unconsidered default — that reads as a wireframe (the **anti-slop** section).

- Code / technical → JetBrains Mono, Space Grotesk, IBM Plex Mono
- Editorial / luxury → Playfair Display, Crimson Pro, Fraunces
- Modern startup → Clash Display, Satoshi, Cabinet Grotesque, General Sans
- Humanist neutral → Söhne, Geist, Hanken Grotesk

Decide tone first, then pick. A serif display (Fraunces) over a neutral text (Geist) signals editorial; Clash Display over Satoshi signals startup. One mismatch and the whole page feels off.

### Type scale — modular, with a big top end

UI text: modular ratio 1.2–1.333. Compute each step from the base, don't eyeball.
For display/hero, BREAK the ratio: jump 3×+ from body to hero. Timid 1.5× heroes look like body text.

Example (base 16px, ratio 1.25 for UI, hero broken out):

```
12px caption   ·  14px small   ·  16px body
20px lead      ·  25px h3      ·  31px h2
48px h1        ·  64–96px hero   (3–6× body, not 1.5×)
```

In `rem`: 0.75 / 0.875 / 1 / 1.25 / 1.563 / 1.953 / 3 / 4–6.

### Weight contrast, not size alone

Pair extremes for drama: 200/300 against 700/800. A 96px hero at weight 300 beside a 700 label reads as designed; everything at 400/600 reads as flat.

- [ ] Hero/display: 200–300 (light, large, tracked tight)
- [ ] Headings: 600–800
- [ ] Body: 400; emphasis 500–600
- [ ] Never ship a page where every weight is 400–600

### Body defaults

- [ ] Base ≥ 16px (mobile too — no 14px body)
- [ ] line-height 1.5–1.75 for body, 1.1–1.25 for headings
- [ ] Measure 65–75 characters: `max-width: 65ch`
- [ ] Paragraph spacing ~0.75–1em (or 1lh); never indent AND space
- [ ] Headings get more space above than below

### Micro-typography — the expert tell

These separate professional from amateur. Apply every one.

- [ ] Curly quotes “ ” ‘ ’ and apostrophes ’ — never straight ' "
- [ ] En-dash – for ranges (8–10pm); em-dash — for breaks; hyphen - only for compounds
- [ ] Real ellipsis … not three dots
- [ ] `font-variant-numeric: tabular-nums` for tables, prices, figures, timers
- [ ] `text-wrap: balance` on headings; `text-wrap: pretty` on body
- [ ] No widows/orphans — `&nbsp;` the last two words of headings if needed
- [ ] `hanging-punctuation: first last;` for pull quotes / blockquotes
- [ ] Large display: `letter-spacing: -0.02em` (tighten); small caps/labels: `+0.02em` to `+0.08em`

### Hierarchy roles

Define each role by size + weight + line-height + spacing (color via the **color-system** section):

- [ ] h1/hero — 48–96px, 200–300, lh 1.05, tracking -0.02em
- [ ] h2 — 31px, 700, lh 1.15
- [ ] h3 — 25px, 600, lh 1.2
- [ ] body — 16px, 400, lh 1.6, 65ch
- [ ] small — 14px, 400, lh 1.5
- [ ] caption/label — 12px, 600, lh 1.4, tracking +0.04em, uppercase optional

### Loading

- [ ] `font-display: swap` on every @font-face
- [ ] `<link rel="preload" as="font" crossorigin>` the display font (above-fold)
- [ ] Subset to used glyphs (Latin + the punctuation above); verify weights load with `browser_check`
- [ ] Self-host or one provider; don't chain 3 font CDNs

### Output

Emit tokens to `:root` via `write_file`; verify rendering and FOUT with `browser_check`. Run `run_bash` if a subsetting/build step is needed.

```css
:root {
  --font-display: "Fraunces", Georgia, serif;
  --font-text: "Geist", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --text-xs: 0.75rem;   --text-sm: 0.875rem;  --text-base: 1rem;
  --text-lg: 1.25rem;   --text-xl: 1.563rem;  --text-2xl: 1.953rem;
  --text-h1: 3rem;      --text-hero: clamp(3rem, 8vw, 6rem);
  --weight-light: 300;  --weight-reg: 400;
  --weight-semi: 600;   --weight-bold: 800;
  --lh-tight: 1.1;      --lh-snug: 1.25;      --lh-body: 1.6;
  --measure: 65ch;      --track-tight: -0.02em; --track-wide: 0.04em;
}
body { font: var(--weight-reg) var(--text-base)/var(--lh-body) var(--font-text); }
h1 { font-size: var(--text-hero); font-weight: var(--weight-light);
     line-height: var(--lh-tight); letter-spacing: var(--track-tight);
     text-wrap: balance; }
p  { max-width: var(--measure); text-wrap: pretty; }
```

For component-level application, hand off to the **frontend-design** section.

---

## Spacing & Layout

Spacing is the cheapest signal of quality and the first tell of slop. Snap everything to one
scale, give the layout room, and let unequal space do the grouping. Author tokens once
(the **design-tokens** section), reference them everywhere, then verify rhythm with `browser_check`.

### The 8pt grid
- All padding, margin, gap, width, and height land on multiples of **8**. Use **4** only for
  fine optical nudges (icon insets, 1px-hairline offsets, dense tables).
- Spacing scale (px): **4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96**. Nothing off-scale ships.
- Never hand-type `13px`, `15px`, `margin: 7px`. Reach for a token instead.
- Icons and line-height also snap: a 24px icon in a 40px control (8px inset each side).

### Whitespace is a feature
- Default to **more** padding than feels necessary; crowding reads as cheap.
- Proximity = meaning (gestalt): tight space binds related items, wide space separates groups.
  Label-to-input `8px`; field-to-field `24px`; group-to-group `48px`.
- Section padding scales with viewport: **64–96px** block padding on desktop, **32–48px** mobile.
- Don't pad every edge equally to "balance" — even padding flattens hierarchy.

### Grid & containers
- **12-column** grid with one consistent gutter (`24px` desktop, `16px` mobile).
- Max-widths: long-form prose **~65ch**; app/content shell **1100–1280px**. Center with
  `margin-inline: auto`, never absolute positioning.
- **CSS Grid** for 2D (page shells, card galleries, dashboards). **Flexbox** for 1D
  (toolbars, button rows, nav). Don't nest five flexes to fake a grid.
- Full-bleed only deliberately; default content stays inside the container.

### Vertical rhythm
- Consistent space between stacked blocks; pick gaps from the scale, not ad hoc.
- Relate spacing to the type scale (the **typography** section) — denser type, tighter blocks.
- **More space ABOVE a heading than below it** — the heading belongs to the section it
  introduces, so it must sit nearer its own body. e.g. `margin-top: 48px; margin-bottom: 16px`.
- Stacks: use `gap` on a flex/grid column, not trailing margins that collapse unpredictably.

### Alignment
- Establish ONE strong left/baseline edge and hold it down the whole page.
- Optical-align icons and punctuation — true geometric center often looks off; nudge by `4px`.
- Don't center long-form text or "center everything." Centering is for short hero lines and
  empty states only (the **anti-slop** section).
- Align numbers right / on the decimal in tables; align labels left.

### Hierarchy via space
- **Unequal spacing signals grouping and importance.** When content has a hierarchy, do not
  distribute space evenly — give the primary block more air.
- Whitespace ranks elements as much as size or weight does. Defer the ranking call to
  the **visual-hierarchy** section.

### Density modes
- Offer **comfortable** (default) and **compact** for data-dense UIs, switched via tokens —
  not by retyping values.
- Comfortable row `16px` vertical padding; compact `8px`. Section gaps `32px` → `16px`.
- Compact tightens spacing only; it never drops below the `4px` floor or breaks the grid.

### Responsive
- Re-flow columns, don't shrink-to-fit: 12 → 6 → 1. Scale section padding down per breakpoint.
- See the **responsive-design** section for breakpoint strategy and fluid `clamp()` spacing.

### :root spacing tokens

```css
:root {
  --space-1: 4px;   --space-2: 8px;   --space-3: 12px;
  --space-4: 16px;  --space-6: 24px;  --space-8: 32px;
  --space-12: 48px; --space-16: 64px; --space-24: 96px;

  --gutter: var(--space-6);          /* 16px on mobile via media query */
  --container: 1200px;
  --measure: 65ch;                   /* prose max-width */
  --section-y: clamp(2rem, 6vw, 6rem); /* 32 → 96px */
}

.container { max-width: var(--container); margin-inline: auto; padding-inline: var(--gutter); }
.prose     { max-width: var(--measure); }
.section   { padding-block: var(--section-y); }
.grid-12   { display: grid; grid-template-columns: repeat(12, 1fr); gap: var(--gutter); }
.stack     { display: grid; gap: var(--space-6); }
h2         { margin-top: var(--space-12); margin-bottom: var(--space-4); }
```

### Checklist (run before `write_file` is done)
- [ ] Every spacing/size value is a scale token (4/8/12/16/24/32/48/64/96) — zero off-grid px.
- [ ] Related items grouped by proximity; unrelated separated by larger gaps.
- [ ] Content within a max-width (~65ch prose / 1100–1280px app), centered with auto margins.
- [ ] One dominant left/baseline alignment edge; nothing accidentally centered.
- [ ] Headings carry more space above than below.
- [ ] Space is unequal where hierarchy exists — not distributed evenly.
- [ ] Section padding scales with viewport (64–96 desktop / 32–48 mobile); no horizontal scroll.
- [ ] Grid for 2D, Flex for 1D; gutters consistent.
- [ ] `browser_check` screenshot confirms rhythm reads cleanly at desktop, tablet, and mobile.

---

## Depth & Imagery

Depth is hierarchy you can feel. Use soft, tinted, layered shadows to lift interactive surfaces — never a flat `0.1`-opacity black box on everything. Author the ramp once (the **design-tokens** section), reference it, verify with `browser_check`.

### Shadow / elevation ramp

- Define a **5-level** ramp as tokens: `0 / sm / md / lg / xl`. Nothing off-ramp ships.
- **Tint the shadow** with the surface/brand hue, not pure black. Pure `rgba(0,0,0,.x)` reads cheap and muddy. Drop chroma in, e.g. `hsl(262 40% 12% / α)`.
- **Layer two shadows** per level: a tight *ambient* (small blur, ~1px y, low spread) + a wider *diffuse* (large blur, larger y). Real light casts both.
- Higher elevation = **larger offset, larger blur, LOWER per-layer opacity**. Things far from the surface cast soft, faint shadows — not dark ones.
- Opacity budget: ambient ~0.04–0.10, diffuse ~0.03–0.08. Total stays subtle.
- The `0.1`-opacity-shadow-on-every-card look is a slop tell (the **anti-slop** section). Vary by level; most cards need `sm`, not `lg`.

```css
:root {
  --shadow-color: 262 35% 15%;   /* brand-tinted, not black */
  --shadow-0:  none;
  --shadow-sm: 0 1px 2px  hsl(var(--shadow-color) / .06),
               0 1px 3px  hsl(var(--shadow-color) / .05);
  --shadow-md: 0 2px 4px  hsl(var(--shadow-color) / .06),
               0 4px 10px hsl(var(--shadow-color) / .05);
  --shadow-lg: 0 4px 8px  hsl(var(--shadow-color) / .05),
               0 12px 24px hsl(var(--shadow-color) / .07);
  --shadow-xl: 0 8px 16px hsl(var(--shadow-color) / .05),
               0 24px 48px hsl(var(--shadow-color) / .09);
}
```

### Elevation logic

- Elevation **signals interactivity and hierarchy** — it is not decoration. Map levels to roles:
  flat content `0`, resting card `sm`, hover/dropdown `md`, popover/sticky `lg`, modal/toast `xl`.
- Lift on interaction: card `sm` → `md` on hover, snap back on rest (the **motion-and-animation** section).
- **Prefer a 1px border over a shadow** for low-emphasis separation (list rows, inset panels, table cells). Borders are cheaper and crisper than faint shadows.
- **Don't double up**: heavy shadow + hard border fights itself. Pick one. A faint border *plus* a soft shadow is fine; a `lg` shadow *plus* a 2px border is not.
- Tie z-index to elevation so visual and stacking order agree.

```css
:root {
  --z-base:     0;
  --z-dropdown: 1000;
  --z-sticky:   1100;
  --z-overlay:  1200;   /* scrim/backdrop */
  --z-modal:    1300;
  --z-toast:    1400;
}
```

### Dark mode depth

- Shadows barely register on dark surfaces. Convey elevation by **raising surface lightness** — lighter = higher (the **color-system** section).
- `background` darkest, `surface` lighter, `surface-raised` lighter still. Optionally add a hairline top highlight (`inset 0 1px 0 hsl(0 0% 100% / .04)`) to catch light.
- Keep shadow tokens for `lg`/`xl` modals (the scrim helps), but never rely on a darker shadow to mean "higher" in dark mode.

### Backgrounds for depth

- Add richness with **layered gradients, subtle grain/noise, soft radial glows, or a faint pattern** — keep all of it low-contrast so content stays legible.
- Radial glow behind a hero: large, soft, one brand hue, low alpha. Grain: a tiled noise PNG at ~3–5% opacity kills banding and adds texture.
- Keep contrast under the content. If the background competes with text, it lost.
- Avoid loud rainbow / purple-to-blue gradients — instant slop (the **anti-slop** section).

### Iconography

- **ONE icon set** across the whole UI: Lucide, Phosphor, Heroicons, or Radix Icons. Never mix sets.
- Consistent **stroke width** (e.g. 1.5–2px) and a **size grid** of `16 / 20 / 24`. Match icon weight to text weight.
- **Optically align** — center the visual mass, not the bounding box; nudge by ~1px where needed.
- **NEVER use emoji as UI icons** — they render inconsistently per-OS and look amateur (the **anti-slop** section).
- Icons **support** labels; they rarely replace them. Icon-only controls need an `aria-label` (the **accessibility** section).

### Imagery

- Prefer **real product/content imagery** over generic stock people-pointing-at-laptops.
- Apply **consistent treatment** across all images: same rounding, same duotone/overlay, same crop ratios. Mixed treatments read as a content farm.
- Text over a photo needs a **scrim/overlay** for legibility — a gradient or solid wash, not raw text on busy pixels.
- Set **`aspect-ratio`** on every image to reserve space and prevent layout shift; pair with `object-fit: cover`.
- `loading="lazy"` + `decoding="async"`; serve sized/compressed assets. Fetch references with `web_fetch` if needed.
- Meaningful **`alt`** text; decorative images get `alt=""` (the **accessibility** section).

### Radius

- ONE radius scale used with intent: `sm 6px / md 10px / lg 16px / full 9999px`. Not a random value per element.
- Larger surfaces take larger radii; nested elements use a smaller radius than their container. Pills (`full`) for tags/avatars only.

### Checklist (run before `write_file` is done)
- [ ] 5-level shadow ramp as tokens; every shadow is a token, none off-ramp.
- [ ] Shadows are brand-tinted (not pure black) and **two layers** (ambient + diffuse).
- [ ] Higher level = bigger + softer + lower opacity; no `0.1`-on-everything tell.
- [ ] z-index scale tokens used; stacking order matches elevation.
- [ ] Low-emphasis separation uses a border, not a faint shadow; no border + heavy shadow.
- [ ] Dark mode lifts via surface lightness, not darker shadows.
- [ ] Backgrounds stay low-contrast under content; no rainbow gradients.
- [ ] One icon set, consistent stroke + 16/20/24 grid, optically aligned, zero emoji.
- [ ] Images: consistent treatment, scrim over text, `aspect-ratio` set, lazy-loaded, real `alt`.
- [ ] One radius scale applied with intent.
- [ ] `browser_check` confirms depth reads cleanly in light AND dark.

---

## Component States

A control is not done when it renders. Enumerate its states BEFORE building, define them
ONCE as variants, then exercise every one in `browser_check`. The default state is ~10% of
the work; the other states are where polish (and bugs) live.

### Enumerate up front
Every interactive control needs these. List them before writing markup:

- **default** — resting.
- **hover** — pointer over (pointer devices only; never the sole affordance).
- **active/pressed** — during click/tap; visible push (e.g. scale 0.98, darker by one step).
- **focus-visible** — keyboard focus; a ring, DISTINCT from hover, NEVER removed.
- **disabled** — non-interactive; looks muted AND explains why when non-obvious.
- **selected/checked** — toggles, tabs, radios, menu items, list rows.
- **loading** — async in flight; spinner/skeleton + locked out.
- **error / success** — validation or action result (control-level; defer screens below).

### focus-visible (non-negotiable)
- Ring ≥2px, ≥2px offset, ≥3:1 contrast vs adjacent — see the **accessibility** section.
- Must look DIFFERENT from hover. Reviewer test: tab to it, hover it — two distinct looks.
- Never `outline:none` without a replacement ring. Keyboard users must always see focus.

```css
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
:focus:not(:focus-visible) { outline: none; } /* mouse only; keyboard keeps ring */
```

### disabled
- LOOK disabled: opacity ~0.5 or muted token, `cursor:not-allowed`. Don't rely on color alone.
- Explain WHY when non-obvious: tooltip, helper text, or a near label ("Complete step 2 first").
- Keep discoverable — prefer disabled-with-reason over hiding; a vanished button is unsearchable.
- `disabled` attribute on real `<button>`/`<input>`, not a styled div that still fires clicks.

### loading
- In-place spinner OR skeleton — never a layout jump. Reserve the control's size so nothing shifts.
- MIN display ~300–500ms even if the response is instant, to avoid a flash-then-gone flicker.
- Disable the control while in flight to prevent double-submit; restore exactly on resolve.
- Keep the label; swap icon for spinner or dim text — don't blank the button.

### data/content states (beyond the control)
- empty, partial, error, success exist at the view level too. The control shows its own
  loading/error; the SCREEN treatment (empty illustrations, retry, partial lists) lives in
  the **loading-empty-error-states** section. Don't duplicate it here.

### Transitions between states
- 150–300ms on `transform`/`opacity` only; instant state-swaps feel broken, slow ones feel laggy.
- `ease-out` entering, faster exits. Full curves and reduced-motion in the **motion-and-animation** section.

### Consistency — define once
- States are tokens/variants, not per-instance CSS. Use cva variants so every button/input
  behaves identically — see the **tailwind-and-shadcn** section.
- Author the state matrix once; every instance inherits it. Divergence = bug.

```tsx
const button = cva("transition-colors duration-200 focus-visible:outline-2 …", {
  variants: {
    intent: { primary: "bg-brand hover:bg-brand-600 active:bg-brand-700", ghost: "…" },
    state:  { loading: "opacity-80 pointer-events-none", disabled: "opacity-50 cursor-not-allowed" },
  },
});
```

### Verify (before shipping)
- Screenshot EACH state with `browser_check`: default, hover, active, focus-visible, disabled,
  selected, loading, error.
- Tab through with the keyboard — confirm focus-visible appears and differs from hover.
- Trigger loading; confirm no layout jump, no double-submit, min display time honored.
- Confirm disabled cannot be clicked AND its reason is reachable.

### State matrix (fill before declaring done)
Rows = each control; columns = each state. Mark each cell built + screenshotted.

| Control | default | hover | active | focus-vis | disabled | selected | loading | error |
|---------|---------|-------|--------|-----------|----------|----------|--------|-------|
| Button  | [ ]     | [ ]   | [ ]    | [ ]       | [ ]      |  n/a     | [ ]    | [ ]   |
| Input   | [ ]     | [ ]   | [ ]    | [ ]       | [ ]      |  n/a     |  n/a   | [ ]   |
| Toggle  | [ ]     | [ ]   | [ ]    | [ ]       | [ ]      | [ ]      | [ ]    | [ ]   |

- [ ] focus-visible verified distinct from hover on every row.
- [ ] disabled looks muted AND its reason is discoverable.
- [ ] loading preserves layout, blocks double-submit, honors ~300–500ms min.
- [ ] All transitions 150–300ms `transform`/`opacity`; reduced-motion respected.
- [ ] States come from shared variants/tokens, not one-off styles.

---

## Loading, Empty & Error States

Every data-driven view has FOUR states, not one: loading, loaded, empty, error. AI builds ship
only "loaded" and hope. A blank screen, a spinner that never resolves, or a raw stack trace is a
broken product. Before building any view that fetches, mutates, or filters, ENUMERATE its states
in a comment, then build all of them. Author with `write_file`, force each state, and screenshot
with `browser_check`.

### Rule: enumerate before building
- For every fetch/query/mutation, list which of loading / empty×3 / error apply. Most apply.
- Never a bare spinner-forever, never a blank `<div>`, never `Cannot read property 'x' of undefined` on screen.
- One shared `<Skeleton>`, `<EmptyState>`, `<ErrorState>` — never hand-roll per view (drift guaranteed).

### Loading — skeletons over spinners
- Prefer SKELETONS that mirror the final layout (same boxes, same widths) over a centered spinner: lower perceived wait, zero layout shift when data lands.
- Skeleton shape ≈ real content: 3 rows in → 3 skeleton rows; card grid → skeleton cards. Mismatched skeletons jolt on swap.
- Shimmer/pulse must be SUBTLE — `opacity` 0.5↔1 or a translating gradient, ~1.2–1.6s loop. Quiet, not strobing (the **motion-and-animation** section).
- Set a MIN display ~300–500ms once shown, so a 50ms response doesn't flash-and-vanish the skeleton (flash-of-skeleton is its own jank).
- User-initiated mutation → OPTIMISTIC UI: apply the new state instantly, reconcile/roll back on reply. Don't block the UI on a 200ms round-trip.
- Long or multi-step ops (>~2s, uploads, imports) → determinate progress (%, step N of M), not an indeterminate spinner.
- Spinner is the fallback only: tiny inline waits, or unknown-shape content.

### Empty — three distinct kinds, never a bare "No data"
- **First-run** (no data exists yet): onboarding tone. One sentence on what this view will hold + a primary CTA to create the first item ("Create your first project"). This is the most-skipped state — it's the user's first impression.
- **No-results** (filter/search returned nothing): ECHO the query ("No results for 'foo'") + a button to clear filters or adjust. Never imply the data doesn't exist.
- **Cleared** (user just emptied it): confirm the action + offer Undo. Don't make a deliberate empty look like a failure.
- Every empty state = short helpful message + ONE action. Illustration/icon optional but consistent (the **depth-and-imagery** section).

### Error — calm copy, real recovery
- Message answers three things: what happened, plausibly why, what to do next. "Couldn't load orders — connection dropped. Retry?" not "Error 500".
- ALWAYS a recovery action: Retry, Go back, or Contact. A dead-end error is a trap.
- NEVER surface a raw stack trace, error code, JSON dump, or `undefined` to the user. Log the detail for devs (console/Sentry, inspect via `run_bash`); show the user calm copy.
- Distinguish error CLASSES — each gets different copy/action:
  - network/timeout → "Check your connection" + Retry.
  - validation (4xx) → point to the field, don't blame the user (the **forms-and-inputs** section).
  - permission (401/403) → "You don't have access" + sign-in/request path, not Retry.
  - not-found (404) → "This item was moved or deleted" + back to list.
- PARTIAL failure: when one widget/section fails, isolate it — render the failed card's own error, keep the rest of the page alive. One failed API call must not blank the dashboard (error boundary per region).

### Consistency & accessibility
- Same icon/illustration treatment across all empty + error states (the **depth-and-imagery** section); same spacing, same button hierarchy.
- Announce async results to AT via `aria-live="polite"` (results loaded, empty, saved); `assertive` only for urgent errors. Loading region gets `aria-busy="true"` (the **accessibility** section).
- On state swap, keep focus sensible: don't yank it; move to the new heading/Retry button only when the old focused node disappears.

### Verification — force every state
1. Loading: throttle network (DevTools "Slow 3G") or delay the mock; confirm skeleton, min-display, no layout shift.
2. Empty ×3: return `[]` for first-run; search a nonsense string for no-results; clear/delete for cleared+undo.
3. Error: throw in the fetch / return 500 / kill the endpoint; confirm calm copy + working Retry, no stack trace leaks.
4. `browser_check` each forced state and screenshot. A view isn't done until all four screenshots exist.

### Tiny skeleton snippet
```jsx
function List({ status, items, query, onRetry, onClear }) {
  if (status === "loading") return <Skeleton rows={3} />;   // mirrors loaded layout
  if (status === "error")   return <ErrorState onRetry={onRetry} />;
  if (items.length === 0)
    return query
      ? <EmptyState kind="no-results" query={query} onClear={onClear} />
      : <EmptyState kind="first-run" cta="Create your first item" />;
  return <ul aria-live="polite">{items.map(/* … */)}</ul>;
}
```
```css
.skeleton { animation: pulse 1.4s ease-in-out infinite; }   /* subtle, min ~300ms shown */
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
@media (prefers-reduced-motion: reduce) { .skeleton { animation: none } }
```

### Per-view checklist (run for EVERY data view)
- [ ] States enumerated up front; shared `<Skeleton>`/`<EmptyState>`/`<ErrorState>` reused, not hand-rolled.
- [ ] Loading = layout-mirroring skeleton, subtle shimmer, min ~300–500ms display, no shift on swap.
- [ ] Mutations show optimistic UI; long/multi-step ops show determinate progress.
- [ ] Empty first-run: guidance + primary CTA to create the first item.
- [ ] Empty no-results: echoes the query + clear/adjust action.
- [ ] Empty cleared: confirms + offers Undo. No bare "No data" anywhere.
- [ ] Error: human copy (what/why/next) + recovery action; no stack trace/code/`undefined` shown; dev detail logged.
- [ ] Error classes distinguished (network / validation / permission / 404); partial failure isolated per region.
- [ ] `aria-live` announces results; `aria-busy` on loading; focus stays sensible (the **accessibility** section).
- [ ] All four states forced (throttle / `[]` / nonsense query / throw) and screenshotted via `browser_check`.

---

## Forms & Inputs

Every field is a tax on the user. Cut fields, then make the survivors effortless. Validate late,
fail gently, never lose typed data. Verify the real DOM and announcements with `browser_check`.

### Labels
- EVERY field has a visible, programmatically-linked `<label for="id">` (or wraps the input). No exceptions.
- Placeholder is NOT a label — it vanishes on first keystroke, drops below 4.5:1 contrast, and breaks recall. Use it only for format hints (`+1 555 0100`), never identity.
- Top-aligned labels scan fastest (one eye sweep, fewest fixations) and fit mobile width. Reserve left-aligned for dense settings panes only.
- Mark the SHORTER set: if most fields are required, mark only optional ones `(optional)`. Else mark required with `*` + one legend ("* required") — never asterisk with no key.
- Label text = the noun the user thinks in ("Email"), not the DB column (`user_email`).

### Layout
- Single column for any linear form. Multi-column splits the eye path and reads as unrelated fields; collapse to one column ≤640px always.
- Group related fields with `<fieldset>`/`<legend>` + spacing; sections separated by ~1.5–2× the within-group gap (see the **spacing-and-layout** section).
- Logical order matching mental model (name → email → password; not DB order). Ask only what you need now.
- ONE primary action. De-emphasize secondary ("Cancel" = text/ghost, not a second solid button) — the **component-states** section.
- Place the submit button after the last field, left-aligned with inputs; don't strand it.

### Validation
- Validate on **blur** and on **submit** — NOT on every keystroke (premature red while typing is hostile). Exception: positive, live password-strength meters.
- Once a field has errored, re-validate on input so the user sees it clear in real time.
- Errors inline, adjacent to the field, in plain language: state WHAT is wrong AND HOW to fix. "Enter a date in the future (MM/DD/YYYY)" — not "Invalid input".
- NEVER reset or clear entered data on error. Preserve every value; only flag the offenders.
- Long forms (>~6 fields): render an error summary at top listing each problem as a link, then move focus to the first invalid field.
- Validate server-side too; client checks are UX, not security.

### Input ergonomics
- Correct `type` + `inputmode` + `autocomplete` so keyboards, autofill, and validation come free:
  - email → `type="email" autocomplete="email"`; phone → `type="tel" inputmode="tel" autocomplete="tel"`.
  - numeric codes → `inputmode="numeric"`; name → `autocomplete="name"`; OTP → `autocomplete="one-time-code"`.
- Sane defaults (country from locale, today's date) cut taps to zero where possible.
- Format-as-you-type for KNOWN formats only (card number groups, phone) — never fight free text.
- Pick the control for the data: radio for ≤5 mutually exclusive options, `<select>` for >5, checkbox for multi-select, toggle for an instant binary state (not for form fields awaiting submit).
- Set `maxlength`, `min`/`max`, `step`, `pattern` where the domain is bounded.

### States
- focus: visible ring (`:focus-visible`, ≥2px, ≥3:1) — never `outline:none` bare.
- error: `aria-invalid="true"` + message linked via `aria-describedby`; red border PLUS icon/text (not color alone).
- disabled vs read-only: `disabled` = not submitted, not focusable; `readonly` = submitted, focusable, copyable. Choose deliberately.
- submit loading: disable the button, show a spinner/label swap, and guard against double-submit (set a pending flag, not just disabled styling).
- success: confirm explicitly after submit — inline message, redirect, or toast. Never leave the user guessing. See the **loading-empty-error-states** section.

### Accessibility
- Fully keyboard-operable; Tab order follows visual order; Enter submits from any text field.
- Visible focus on every control; hit targets ≥ **44×44px** (pad checkboxes/radios + their labels).
- Announce errors via `aria-live="assertive"` (summary) / `polite` (inline) so screen readers hear changes.
- Associate hints and errors through `aria-describedby`; group radios/checkboxes in `<fieldset>`/`<legend>`. Full set: the **accessibility** section.
- Error red and field borders must clear 3:1 — the **color-system** section.

### Don'ts
- [ ] Placeholder used as the only label.
- [ ] Resetting/clearing the form (or any field) on a validation error.
- [ ] Vague messages: "invalid input", "error", "required field" with no fix.
- [ ] Submit disabled until valid with no inline reason the user can act on.
- [ ] Multi-column layout on mobile / narrow viewports.
- [ ] Validating angrily on every keystroke before first blur.
- [ ] `type="text"` for email/phone/number (kills mobile keyboards + autofill).

### Ship checklist
- [ ] Every field: visible `<label for>`; optional/required marked consistently with a legend.
- [ ] Single column; related fields grouped; one primary action, secondary de-emphasized.
- [ ] Validate on blur + submit (live only for password strength + already-errored fields).
- [ ] Inline human errors stating problem + fix; data preserved; top summary + focus move on long forms.
- [ ] Correct `type`/`inputmode`/`autocomplete`; right control per data; field count minimized.
- [ ] States covered: focus, `aria-invalid`+`aria-describedby` error, disabled/read-only, loading (double-submit blocked), success confirmation.
- [ ] Keyboard-complete, 44px targets, errors announced via `aria-live`; `browser_check` passes.

### Minimal accessible field
```html
<div class="field">
  <label for="email">Email</label>
  <input
    id="email" name="email" type="email"
    autocomplete="email" inputmode="email"
    aria-invalid="true" aria-describedby="email-error" required />
  <p id="email-error" class="error" role="alert">
    Enter a valid email, like name@example.com.
  </p>
</div>
```

---

## Data Tables

A table is two systems welded together: LOGIC (sort, filter, paginate, select, resize) and PRESENTATION (markup + style). Keep them separate. Own the markup; rent the logic from a headless engine. Build with `write_file`, verify rendering and keyboard nav with `browser_check`.

### Pick the right tool

- **TanStack Table** — headless logic, you write every `<th>`/`<td>`. DEFAULT for app tables.
- **shadcn/ui Table** — TanStack wired into styled primitives. Fastest path to clean (the **tailwind-and-shadcn** section).
- **AG Grid / Glide Data Grid** — only at 50k+ rows, spreadsheet-grade editing, or true row virtualization.
- **Plain semantic `<table>`** — under ~20 static rows. Do NOT pull a library; it's a liability.

Rule: if you can't restyle every cell, the tool is wrong. Never ship a vendor's grid skin.

### Semantics (non-negotiable)

- Real `<table><thead><tbody>` — never `<div>` soup. Screen readers and copy/paste depend on it.
- `<th scope="col">` on header cells, `<th scope="row">` on the row's primary cell.
- One `<caption>` (visually hidden is fine) naming the table.
- Sortable headers are `<button>`s inside `<th>`; announce direction with `aria-sort="ascending|descending|none"`. See the **accessibility** section.
- Full keyboard path: tab to sort buttons, checkboxes, row actions; visible focus ring on each.

### Alignment — the one rule that reads as "designed"

- Text / labels → **left**.
- Numbers, currency, percentages, dates-as-numbers → **right**, so magnitudes line up by place value.
- Apply `font-variant-numeric: tabular-nums` to numeric columns so digits share one width and rows scan as columns.
- Header alignment matches its column's body alignment. Always.

### Density & readability

- Row height **44–48px** comfortable; **36–40px** compact mode only when asked.
- Cell padding **12px** vertical, **16px** horizontal minimum — crowded cells read cheap.
- Separation = subtle 1px bottom border OR zebra striping (`oklch` ~2% lift). NOT both, NEVER a full grid of borders on every cell.
- Sticky header on scroll: `position: sticky; top: 0` on `<thead>`, opaque background + bottom border so rows slide under it.
- Hover row highlight to anchor the eye across wide rows.

### Content discipline

- Primary identifying column first; row actions last.
- Right-size columns to content; pin sensible `min/max-width`. No single column hogging the table.
- Truncate long cells: `text-overflow: ellipsis` + `title`/tooltip or click-to-expand. Never wrap to 4 lines.
- Format consistently per column: same decimals, same date format, units in the header not every cell.

### Interaction

- Column sort (single, shift-click for multi where it earns its keep).
- Filter: per-column or one global search; debounce input.
- Row selection: leading checkbox column; header checkbox = select-all-on-page.
- Row actions: trailing column, icon `<button>`s or a `⋯` menu — not a wall of links.
- On selection, show a **bulk-actions bar** (count + actions), replacing or floating over the header.
- Moderate sets → pagination (show range + total). Huge sets → virtualization, not 10k DOM rows.

### States — never a blank grid

- **Empty (no data)**: illustration + one-line explanation + primary action ("Add the first row").
- **Empty (no results for filter)**: distinct copy + a "Clear filters" button. Different from no-data.
- **Loading**: skeleton rows that mirror the real column count/widths — not a centered spinner.
- **Error**: inline message + retry; keep the header/structure visible.
- Detail in the **loading-empty-error-states** section.

### Responsive

- Narrow viewports: switch to **stacked cards** (label: value per row) OR horizontal scroll with a **pinned first column** (`position: sticky; left: 0`).
- Never let a wide table silently overflow and clip. See the **responsive-design** section and the **spacing-and-layout** section.

### Checklist

- [ ] Logic from headless engine; markup hand-owned and restyleable
- [ ] Semantic `<table>`, `scope` on every header, `<caption>` present
- [ ] Sortable headers are buttons with live `aria-sort`
- [ ] Numbers right-aligned + `tabular-nums`; text left-aligned
- [ ] Row 44–48px, generous padding, ONE separation style, sticky header
- [ ] Truncation + tooltip; consistent number/date/unit formatting
- [ ] Selection checkboxes + bulk bar; row actions in trailing column
- [ ] Pagination or virtualization sized to row count
- [ ] Empty / no-results / loading-skeleton / error all designed
- [ ] Stacks to cards or pinned-scroll on mobile; `browser_check` passes

### Snippet

```html
<table>
  <caption class="sr-only">Invoices, June 2026</caption>
  <thead>
    <tr>
      <th scope="col"><input type="checkbox" aria-label="Select all"></th>
      <th scope="col">Client</th>
      <th scope="col" aria-sort="descending">
        <button type="button">Amount</button>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><input type="checkbox" aria-label="Select row"></td>
      <th scope="row" class="text-left truncate" title="Northwind Traders">Northwind Traders</th>
      <td class="text-right tabular-nums">$1,284.00</td>
    </tr>
  </tbody>
</table>
```

```css
.text-right { text-align: right; }
.tabular-nums { font-variant-numeric: tabular-nums; }
thead th { position: sticky; top: 0; background: var(--surface); }
tbody tr { border-bottom: 1px solid var(--border); height: 44px; }
```

---

## Motion & Animation

Motion is a tool, not decoration. Every animation must communicate one of: state change, spatial
relationship, feedback, or continuity. If it only decorates, cut it. Restraint reads as premium;
scattered competing micro-animations read as "AI-generated" (the **anti-slop** section). Author with
`write_file`, then verify timing and reduced-motion with `browser_check`.

### Timing — fast, numeric, never sluggish
- Micro-interactions (hover, press, focus, toggle): 150–300ms.
- Larger transitions (modal, drawer, route, layout shift): 300–500ms.
- Exits run at ~60–70% of the enter duration — leave faster than you arrive (enter 300ms → exit ~200ms).
- Never exceed ~500ms for UI feedback; beyond that the interface feels laggy, not luxurious.
- Stagger between revealed items: 50–80ms. More than ~6–8 staggered items reads as a slideshow — cap it.

### Easing — match the curve to the direction
- Entering elements → `ease-out` (decelerate into place): fast start, soft landing.
- Exiting elements → `ease-in` (accelerate away): they're leaving, get them gone.
- Bidirectional / move-in-place → `ease-in-out`.
- Define ONE brand cubic-bezier and reuse it; e.g. `cubic-bezier(0.22, 1, 0.36, 1)` for a confident overshoot-free settle.
- Avoid `linear` except spinners and continuous/looping motion (shimmer, marquee, progress).

### Performance — composite only
- Animate ONLY `transform` and `opacity`. These are GPU-composited and skip layout/paint.
- NEVER animate `width`, `height`, `top`, `left`, `margin`, or `box-shadow` in hot paths — they thrash layout.
  Need a moving shadow? Cross-fade two `opacity` layers. Need resize? `transform: scale()`.
- `will-change: transform` only on the element about to move, and remove it after; permanent `will-change` wastes GPU memory.
- Target 60fps. If `browser_check` shows jank, you're animating a non-composited property — find it and convert to transform/opacity.

### One orchestrated reveal beats many scattered ones
- Prefer a SINGLE staggered page-load reveal over a dozen independent entrance animations firing on scroll.
- One direction (e.g. fade + 8–12px rise), one easing, one stagger rhythm — coherent, not a fireworks show.
- Don't animate everything on every scroll; reveal once, then leave it. Repeated re-entrance is a tell (the **anti-slop** section).

### Micro-interactions — tie to component states
- Map every interactive state to a transition: hover, press (active), focus-visible, disabled, loading.
- Press feedback: `transform: scale(0.97)` over ~120ms; release springs back via `ease-out`.
- Focus rings transition `opacity`/`outline-offset`, never just appear hard — but keep them instant enough to feel responsive (~120ms).
- Optimistic UI: apply the new state immediately on action, animate it, reconcile on server reply. See the **component-states** section.

### Loading & skeleton motion
- Subtle shimmer or pulse only — `opacity` 0.5↔1 or a translating gradient sweep; keep it quiet, not strobing.
- Enforce a minimum display time (~300–500ms) so spinners/skeletons don't flash-and-vanish on fast responses.
- Spinners: `linear`, infinite, `transform: rotate`. Details: the **loading-empty-error-states** section.

### Accessibility — non-negotiable
- ALWAYS wrap non-essential motion in `@media (prefers-reduced-motion: reduce)` and disable or replace it (cut transforms, keep instant `opacity`).
- Preserve essential feedback (focus, error) but strip parallax, autoplay, large slides, spin. See the **accessibility** section.
- No motion that flashes >3×/sec. Provide a non-motion path to every state change.

### Tooling — reach for the smallest thing
- CSS transitions/keyframes FIRST — covers ~90% (hover, reveals, toggles, spinners).
- Framer Motion: React orchestration, layout/shared-element transitions, exit animations.
- GSD/GSAP: complex sequenced timelines, scroll-scrubbing.
- Lottie: vector illustration playback only.
- Don't pull a library for a fade. Adding 40KB of JS to cross-fade a button is a code smell.

### Output
Emit reusable motion tokens to `:root`, guard with reduced-motion, then `browser_check` for timing and 60fps.

```css
:root {
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in: cubic-bezier(0.55, 0, 1, 0.45);
  --dur-micro: 200ms;
  --dur-enter: 360ms;
  --dur-exit: 240ms;        /* ~67% of enter */
  --stagger: 60ms;
}
@keyframes rise-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: none; }
}
.reveal > * {
  opacity: 0;
  animation: rise-in var(--dur-enter) var(--ease-out) both;
  animation-delay: calc(var(--i, 0) * var(--stagger));  /* set --i per item */
}
.btn { transition: transform var(--dur-micro) var(--ease-out); }
.btn:active { transform: scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .reveal > * { opacity: 1; transform: none; }
}
```

### Checklist (before declaring motion done)
- [ ] Every animation communicates state/space/feedback/continuity — zero pure decoration.
- [ ] Micro 150–300ms; transitions 300–500ms; nothing over ~500ms for feedback.
- [ ] Exits run faster than enters (~60–70%).
- [ ] `ease-out` in, `ease-in` out; one brand cubic-bezier; `linear` only for continuous motion.
- [ ] Only `transform`/`opacity` animated; no width/height/top/left/box-shadow in hot paths.
- [ ] `will-change` scoped and removed; 60fps confirmed in `browser_check`.
- [ ] One orchestrated reveal (50–80ms stagger), not scattered competing animations.
- [ ] Hover/press/focus/loading states all have intentional transitions (the **component-states** section).
- [ ] Skeleton/shimmer subtle, with a min display time (the **loading-empty-error-states** section).
- [ ] `prefers-reduced-motion: reduce` guard present and tested; essential feedback preserved.
- [ ] No library pulled in for what CSS does natively.

---

## Accessibility

AA is a build constraint, not a final-pass audit. Bake it in while coding, then verify with
`browser_check`. The cheapest fix is the one you never had to retrofit. Rule of thumb:
if you reach for `<div onClick>`, you already lost — use the real element.

### Semantic HTML first
Native elements ship behavior, focus, and roles for free. Use them before any ARIA.

- `<button>` for actions, `<a href>` for navigation. Never a clickable `<div>`/`<span>`.
- `<nav>` `<main>` `<header>` `<footer>` `<aside>` for landmarks; one `<main>` per page.
- `<ul>/<ol>/<li>` for lists; `<table>` (with `<th scope>`) for tabular data, never CSS grid faking it.
- `<label>` for every input; `<fieldset>/<legend>` for related groups.
- Headings: exactly ONE `<h1>`; never skip a level (h2 → h4 is a fail). Headings describe structure, not size.
- ARIA only to fill a genuine gap. **No ARIA is better than bad ARIA** — a wrong `role` overrides native semantics and breaks AT.

### Keyboard — everything operable without a mouse
- Every interactive element reachable by Tab and operable by Enter/Space. Tab order follows DOM/visual order.
- Never `tabindex` > 0. Use `tabindex="0"` to add, `tabindex="-1"` to remove + focus programmatically.
- Visible focus on `:focus-visible`. NEVER `outline: none` without a replacement ring (≥2px, ≥3:1 contrast vs adjacent).
- `Escape` closes overlays/menus/popovers. Arrow keys navigate menus, listboxes, tabs, radio groups.
- Modals: trap focus inside while open; restore focus to the trigger on close; `aria-modal="true"`.

```css
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
:focus:not(:focus-visible) { outline: none; } /* mouse users only; keyboard keeps the ring */
```

### Contrast & color
- Text **4.5:1**; large text **3:1** (≥24px, or ≥19px/~14pt bold). UI components, icons, focus rings, borders: **3:1**.
- Never convey meaning by color alone — pair with icon, text, or pattern (e.g. error = red border **+** ✕ icon **+** message).
- Check disabled/placeholder/muted text too; "muted gray on white" is the usual silent failure.
- Palette and token ratios live in the **color-system** section.

### Targets & motion
- Touch/click targets ≥ **44×44px** (pad small icons; spacing counts toward the gap, not the hit area).
- Honor `prefers-reduced-motion: reduce` — kill parallax, autoplay, large transforms; keep opacity/≤150ms only.
- Motion specifics: the **motion-and-animation** section.

### Forms
- Programmatic `<label for>` (or wrapping) on EVERY field. Placeholder is not a label.
- Errors: `aria-invalid="true"` + message linked via `aria-describedby`; describe the fix, not just "invalid".
- Group radios/checkboxes in `<fieldset>` with a `<legend>`. Mark required with `required` + visible cue.
- Full treatment: the **forms-and-inputs** section; per-state styling: the **component-states** section.

### Media & content
- `<img alt>`: meaningful description for content images; **empty `alt=""`** for decorative (don't drop the attribute).
- `<html lang="en">` set; mark inline language shifts with `lang`.
- Captions/transcripts for audio/video. Link text describes the target — never "click here" / "read more".
- First focusable element = a skip-to-content link (visible on focus) jumping to `<main id="main">`.

```html
<a href="#main" class="skip-link">Skip to content</a>
```

### Dynamic & async
- Announce async updates via `aria-live="polite"` (toasts, search results, save status); `assertive` only for urgent errors.
- SPA route change: move focus to the new `<h1>` or `<main>`; update `<title>`.
- Reflect state: `aria-expanded` on disclosure/menu triggers, `aria-current="page"` on the active nav link, `aria-selected` on tabs.
- Loading regions: `aria-busy="true"`; empty/error/loading states stay reachable and labeled.

### Testing — verify, don't assume
1. Tab through the whole page keyboard-only: reach every control, no traps, order is logical, focus always visible.
2. `browser_check` to screenshot focus states and confirm the ring renders on each interactive element.
3. Run an automated pass via `run_bash` where available, e.g.
   `npx @axe-core/cli http://localhost:3000` or `npx lighthouse <url> --only-categories=accessibility --quiet`.
4. Zoom to **200%** — no clipped text, no horizontal scroll, no overlap.
5. Automated tools catch ~30%; the keyboard + screenshot pass catches the rest. Both are required.

### AA pass/fail checklist
- [ ] One `<h1>`; heading levels never skipped; landmarks present (`main`/`nav`/`header`).
- [ ] Every interactive element is a native control or has correct role + keyboard handling.
- [ ] Full keyboard operability; logical tab order; no `tabindex` > 0; no keyboard traps.
- [ ] Visible `:focus-visible` ring everywhere; no bare `outline: none`.
- [ ] `Escape` closes overlays; modals trap + return focus; menus/tabs do arrow-key nav.
- [ ] Text ≥4.5:1, large ≥3:1, UI/borders/icons ≥3:1; meaning never by color alone.
- [ ] Targets ≥44×44px; `prefers-reduced-motion` respected.
- [ ] Every input labeled; errors via `aria-invalid` + `aria-describedby`; groups in `fieldset/legend`.
- [ ] Images have correct `alt`; `lang` set; link text descriptive; skip-link present.
- [ ] `aria-live` for async updates; focus managed on route change; `aria-expanded`/`aria-current` accurate.
- [ ] Keyboard + `browser_check` screenshot pass done; axe/Lighthouse clean; 200% zoom holds.

Run this before declaring any UI done. A `[Blocker]` in the **design-review** section is any unchecked box above.

---

## Responsive Design

One layout, every width. Author base styles for the smallest screen, then layer up. Reflow the
structure at each breakpoint instead of shrinking it; scale type and space fluidly between them.
Pair with the **spacing-and-layout** section and the **typography** section; verify with `browser_check`.

### Mobile-first

- Write the **320px** base with no media query. Every `@media` is `min-width` and adds, never
  subtracts. Desktop-first `max-width` overrides pile up and rot — don't.
- Breakpoints (px): **640 / 768 / 1024 / 1280 / 1536** (Tailwind `sm md lg xl 2xl`). Add a
  breakpoint only when content breaks, not on a schedule.
- Test the real edges, not the breakpoint values: **375** (phone), **768** (tablet), **1440**
  (laptop). Bugs live between breakpoints, so check 1px below each too (639/767/1023).
- Cap line length on huge screens: a `max-width` container beats letting prose run 200ch wide.

### Fluid type & space

- Use `clamp(min, preferred-vw, max)` for headings and section padding so they scale **smoothly**
  instead of snapping at each breakpoint. Lock `min`/`max` so it never goes unreadable.
- Preferred term mixes `rem` + `vw` (e.g. `1rem + 2vw`) so it respects user zoom — never `vw`
  alone. Floor body at **16px**; never clamp body text below it.

```css
:root {
  --step-0: clamp(1rem, 0.95rem + 0.4vw, 1.125rem);   /* body 16→18 */
  --step-h2: clamp(1.75rem, 1.3rem + 2.2vw, 3rem);    /* h2  28→48 */
  --step-hero: clamp(2.5rem, 1.5rem + 6vw, 6rem);     /* hero 40→96 */
  --section-y: clamp(2rem, 5vw, 6rem);                /* pad 32→96 */
}
h1 { font-size: var(--step-hero); text-wrap: balance; }
.section { padding-block: var(--section-y); }
```

### Container queries — size to the container, not the viewport

- A reusable card/widget lands in 1, 2, or 4 columns; the **viewport** can't tell it which.
  Query its container so the same component reflows correctly everywhere.
- Set `container-type: inline-size` on the wrapper, then `@container (min-width: …)` on the child.

```css
.card-wrap { container-type: inline-size; }
@container (min-width: 28rem) {
  .card { display: grid; grid-template-columns: 8rem 1fr; }
}
```

### Reflow, don't shrink

- Change the **layout**, don't uniformly scale it down. Multi-column → single column on mobile.
- Grid columns → stacked rows: `grid-template-columns: 1fr` at base, `repeat(2,1fr)` at `md`,
  `repeat(4,1fr)` at `lg`. Prefer `repeat(auto-fit, minmax(16rem, 1fr))` to self-reflow.
- Sidebar → top bar or drawer below `1024`. Inline nav → hamburger. Tabs → accordion/select.
- Tables → stacked cards or horizontal scroll on narrow screens (the **data-tables** section).

### Touch

- Min target **44×44px** (`48px` comfortable); pad the hit area beyond the visual if needed.
- Spacing **≥8px** between adjacent targets so fat fingers don't mis-tap.
- No hover-only affordances on touch — menus, tooltips, reveals must work on tap. Gate with
  `@media (hover: hover)`. Keep focus-visible states.
- Put primary actions in the **bottom third** (thumb-reachable); avoid top corners for key CTAs.

### Images & media

- `max-width: 100%; height: auto` on every image — no fixed pixel widths that overflow.
- Serve `srcset` + `sizes` so phones don't download the desktop hero. Use `<picture>` for art
  direction (different crop per breakpoint).
- Reserve space with `aspect-ratio` (or width/height attrs) to kill layout shift (CLS).
- `loading="lazy"` below the fold; `object-fit: cover` for fills.

```css
img { max-width: 100%; height: auto; }
.media { aspect-ratio: 16 / 9; object-fit: cover; }
```

### No overflow, ever

- Zero horizontal scroll at any width. Hunt the culprit: fixed `px` widths, unbroken strings,
  oversized media, negative margins. Wrap long words with `overflow-wrap: anywhere`.
- Prefer `%`, `fr`, `minmax()`, `min()`/`max()` over hard pixel widths. `width: min(100%, 40rem)`.
- Respect notches: `padding: env(safe-area-inset-*)` on fixed top/bottom bars; set the viewport
  meta `viewport-fit=cover`. Use `100dvh` not `100vh` so mobile chrome doesn't clip.

### Verify

- `browser_check`: resize to **375**, **768**, **1440** and screenshot each. Then drag through
  the in-between widths watching for overlap, clipping, and a horizontal scrollbar.
- Confirm tap targets, drawer/hamburger toggles, and that no text is truncated. Route the visual
  pass through the **design-review** section; check contrast/focus via the **accessibility** section.
- Emit final styles with `write_file` only after all three widths pass clean.

### Checklist (run before `write_file` is done)
- [ ] Base styles mobile-first; all media queries are `min-width` (640/768/1024/1280/1536).
- [ ] Headings & section padding use `clamp()`; body never below 16px; `vw` never used alone.
- [ ] Reusable components use `@container`, not viewport queries.
- [ ] Layout **reflows** (grid→stack, sidebar→drawer, table→cards) — not shrunk uniformly.
- [ ] Touch targets ≥44px, ≥8px apart; no hover-only actions; primary CTA thumb-reachable.
- [ ] Images `max-width:100%`, `srcset`/`sizes`, `aspect-ratio` set; no CLS.
- [ ] No horizontal scroll or overflow at any width; no fixed px widths that break.
- [ ] `safe-area-inset` honored; `100dvh` not `100vh`.
- [ ] `browser_check` screenshots at 375/768/1440 all clean — no overlap or clipping.

---

## Tailwind v4 + shadcn/ui

Tailwind is the utility layer; shadcn/ui is copy-in components you own and restyle. Wire both to ONE token system so every utility resolves to a design decision. Build with `write_file`/`edit_file`, verify rendering at 375/768/1280 with `browser_check`.

### Detect the stack first — match, don't impose

- [ ] `read_file package.json` — confirm `tailwindcss` (v4 vs v3 differs hard), `tailwind-merge`, `clsx`, `class-variance-authority`, `@radix-ui/*`.
- [ ] `repo_map` for `components/ui/`, `app/globals.css`, `components.json`, `tailwind.config.*`. shadcn already wired? Reuse its conventions.
- [ ] v3 vs v4: v3 configures tokens in `tailwind.config.js`; **v4 configures in CSS via `@theme`** and needs no config file. Check before editing the wrong place.
- [ ] If the repo uses another system (CSS Modules, MUI, vanilla-extract, styled-components) — **do NOT bolt Tailwind/shadcn on top.** Extend what exists.

### Tailwind v4: tokens live in CSS

Define design tokens (the **design-tokens** section) once in `@theme`; utilities like `bg-primary`, `gap-4`, `rounded-lg` then reference the system automatically. Namespaces matter: `--color-*` → color utilities, `--spacing-*` → spacing/gap/padding, `--radius-*` → rounding.

```css
@import "tailwindcss";
@theme {
  --color-background: oklch(0.99 0.01 255);
  --color-surface:    oklch(0.97 0.02 255);
  --color-primary:    oklch(0.55 0.18 255);
  --color-primary-foreground: oklch(0.99 0.01 255);
  --color-border:     oklch(0.88 0.02 255);
  --color-ring:       oklch(0.55 0.18 255);
  --spacing:          0.25rem;            /* 4px base; gap-4 = 16px */
  --radius-md:        0.5rem;
}
```

- Prefer scale utilities (`p-4`, `text-lg`, `gap-2`) over arbitrary values `p-[17px]`. Arbitrary `[...]` is a last resort — it means a token is missing; add the token instead.
- Zero raw hex/px in markup. If you type `#`, you skipped a token.

### shadcn/ui: copy-in, Radix-backed, yours to edit

- It is NOT an npm dependency you import — it COPIES source into `components/ui/`. You own and edit that code.
- Built on Radix primitives → keyboard nav, focus, ARIA correct by default (the **accessibility** section). Don't reimplement behavior you got for free.
- Add: `run_bash "npx shadcn@latest add button dialog table"`. Land files in the project's existing `components/ui/` dir (read `components.json` for the alias).
- Restyle through tokens (edit `@theme` / the component's cva), don't fight the component with `!important` or wrapper overrides.

### Compose classes with cn() — never string-concat

`cn()` = `clsx` (conditionals) + `tailwind-merge` (dedupes conflicting utilities so the last wins). Manual concat ships both `px-2` and `px-4`; `cn()` keeps `px-4`.

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...i: ClassValue[]) => twMerge(clsx(i));
// cn("px-2", isWide && "px-4", className)  ->  resolves to one px-*
```

### Variants with cva — states stay consistent

Define size/variant/state as data with `class-variance-authority` so every instance is uniform (the **component-states** section). One source of truth per component, not ad-hoc class strings at each call site.

```ts
import { cva, type VariantProps } from "class-variance-authority";
export const button = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        solid:   "bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border border-border bg-surface hover:bg-surface/80",
        ghost:   "hover:bg-surface",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4", lg: "h-11 px-6" },
    },
    defaultVariants: { variant: "solid", size: "md" },
  },
);
export type ButtonProps = VariantProps<typeof button>;
// <button className={cn(button({ variant, size }), className)} />
```

### Dark mode: class strategy, swap token VALUES

Toggle a `.dark` class on the root; redefine the token values there. Utilities don't change — `bg-surface` is correct in both themes (the **color-system** section). Never sprinkle `dark:bg-x` per utility.

```css
.dark {
  --color-background: oklch(0.18 0.02 255);
  --color-surface:    oklch(0.22 0.02 255);
}
```

### Hygiene

- Order utilities consistently: **layout → box → typography → color → state**, e.g. `flex items-center p-4 text-sm text-foreground hover:bg-surface`.
- Repeated cluster (3+ uses)? Extract a component or a cva variant — NOT `@apply` soup. `@apply` only for true primitives.
- Mobile-first: base styles unprefixed, layer up with `sm:`/`md:`/`lg:` (the **responsive-design** section). Never desktop-first with `max-*` overrides.
- Tables and complex grids: the **data-tables** section.

### Checklist

- [ ] Stack detected via `read_file`/`repo_map`; matched existing conventions, didn't impose a new system
- [ ] Tokens in `@theme` (v4) wired to the design-tokens system; utilities reference roles
- [ ] Scale utilities over arbitrary `[...]`; zero raw hex/px in markup
- [ ] shadcn added via `run_bash`, files in `components/ui/`, restyled via tokens not overrides
- [ ] `cn()` for all conditional/merged classes; no manual concat
- [ ] Variants defined with `cva`; size/variant/state consistent
- [ ] Dark mode swaps token values under `.dark`, not per-utility `dark:`
- [ ] Utilities ordered layout→box→type→color→state; repeats extracted, mobile-first
- [ ] `browser_check` at 375/768/1280 passes light and dark

---

## Landing Page Design

A landing page has one job: convert one audience on one action. Every section earns its place by
moving the visitor toward that action or gets cut. Generic = invisible; commit to ONE aesthetic
(the **frontend-design** section) and make it look like THIS product. Author with `write_file`, pull
2-3 reference sites with `web_fetch` for structure only (never to copy), screenshot the fold with
`browser_check`, then run the 5-second test below.

### Above the fold — get it in 5 seconds
The fold answers what + for whom + why better, instantly. If the visitor must scroll or think, it fails.
- [ ] ONE value-prop headline as the dominant element (≥48px desktop, weight 600-800); states the outcome, not the category
- [ ] One-line subhead (16-20px): who it's for + the differentiator, ≤140 chars
- [ ] Exactly ONE primary CTA — high contrast, ≥44px tall, action verb ("Start free", not "Submit")
- [ ] Secondary CTA allowed ("See how it works") but visually subordinate: ghost/text style, ≤60% weight of primary
- [ ] ≤3 competing elements in the fold; no nav menu with 8 links stealing focus
- [ ] No carousel — a rotating hero buries the message; pick one frame and commit

### Section sequence — each moves the visitor forward
Typical order; reorder by audience, delete any section that doesn't advance the decision:
1. Hero — value prop + primary CTA
2. Social proof — 4-6 logos OR one hard metric OR one named testimonial, immediately under the fold
3. Problem / solution — name the pain in the visitor's words, then resolve it
4. Features as BENEFITS — 3-6 blocks, each "you get X" not "it has Y"
5. How it works — 3 steps max, numbered, concrete
6. Objection handling / FAQ — kill the top 4-6 reasons they'd bounce
7. Pricing (if any) — 2-3 tiers, recommend one, no hidden surprises
8. Final CTA — restate the value prop + repeat the primary action, full-bleed
9. Footer — links, legal, secondary nav
- [ ] Every section has ONE job and ONE focal point (the **visual-hierarchy** section)
- [ ] If a section doesn't change a "no" toward "yes", cut it
- [ ] Repeat the primary CTA every 2-3 sections; never make them scroll back up to act

### Hero composition — avoid the centered cliché
- [ ] Reject centered-everything (text + button + image stacked mid-axis) — the #1 AI tell (the **anti-slop** section)
- [ ] Prefer asymmetric / split layout: copy left (~55%), product visual right (~45%) on ≥1024px
- [ ] Use a REAL product shot, UI screenshot, or live demo — never generic stock or a floating 3D blob
- [ ] Ground imagery in the product's actual domain (the **depth-and-imagery** section); a payroll tool shows a paystub, not abstract gradients
- [ ] One signature element ties hero to brand (a custom rule, a product chrome frame, a data viz)

### Rhythm & pacing — alternate to keep them scrolling
- [ ] Alternate section backgrounds (light → tinted → light) and density to create rhythm; never 6 identical white blocks
- [ ] Strong vertical spacing: 96-160px section padding desktop, 48-80px mobile (the **spacing-and-layout** section)
- [ ] Vary layout per section: full-bleed, then 2-col, then 3-up cards — break the monotony
- [ ] One focal point per section; demote everything else to secondary/tertiary

### Copy — benefit-led, specific, concrete
- [ ] Lead every section heading with the benefit/outcome, not the feature name
- [ ] Use real numbers: "Cut onboarding from 3 days to 20 minutes", not "Save time"
- [ ] Scannable: headings + 1-2 line blurbs; assume they read 20% of words
- [ ] Kill jargon-soup ("synergistic AI-powered platform"); say what it does in plain words
- [ ] Match the visitor's vocabulary, not your internal product names

### Trust — make proof specific and real
- [ ] Testimonials carry full name + role + company (+ photo/logo); anonymous quotes read as fake
- [ ] Metrics are concrete and sourced: "12,000 teams", "99.98% uptime", "$4M saved"
- [ ] Recognizable customer logos OR security/compliance badges (SOC 2, GDPR) where relevant
- [ ] Place first proof point within the first scroll; don't bury credibility

### Motion — one orchestrated reveal, restrained
- [ ] ONE coherent scroll/load reveal: fade + 8-12px rise, single easing, 50-80ms stagger (the **motion-and-animation** section)
- [ ] Reveal each section once on enter; never re-animate on every scroll (a tell)
- [ ] Animate only `transform`/`opacity`; respect `prefers-reduced-motion`
- [ ] No competing micro-animations fighting for attention

### Performance & accessibility
- [ ] Optimize the LCP hero image: explicit width/height, modern format (AVIF/WebP), `fetchpriority="high"`, ≤200KB
- [ ] Lazy-load everything below the fold (`loading="lazy"`); defer non-critical JS
- [ ] Semantic landmarks: `<header> <main> <section> <footer>`, one `<h1>`, logical heading order
- [ ] CTA + body contrast ≥4.5:1; focus-visible on every interactive element (the **accessibility** section)
- [ ] Responsive at 375 / 768 / 1440: hero stacks on mobile, CTA stays above the mobile fold (the **responsive-design** section)

### Distinctiveness — commit to one aesthetic
- [ ] Pick ONE named direction and bind type, color, spacing, motion to it (the **frontend-design** section, the **typography** section)
- [ ] A visitor should not be able to swap your logo for a competitor's — it must look like this product
- [ ] Spend boldness in ONE place (hero or signature element); keep the rest calm

### Ship checklist + 5-second clarity test
- [ ] Walk the section sequence; confirm each advances the conversion or is removed
- [ ] `browser_check` the fold at 1440 and 375; screenshot it
- [ ] 5-SECOND TEST: glance at the screenshot for 5s — can you state what it is, who it's for, why better, and the one action? If not, the headline/CTA/hierarchy is broken — fix before shipping
- [ ] Verify single `<h1>`, single primary CTA, LCP image optimized, reduced-motion honored

---

## Dashboard Design

A dashboard is a decision tool, not a wall of widgets. In under 3 seconds the user must read the few numbers that matter, spot what changed, and know the next action. Lead with answers, bury the detail. Build with `write_file`, verify at desktop and narrow widths with `browser_check`.

### Lead with KPIs, then disclose

- [ ] Surface **3-5 headline KPIs** at the top — the metrics a user actually steers by. More than 7 is noise; nothing is hero.
- [ ] Each KPI: **large number** (32-48px, `tabular-nums`), label, and a **delta vs prior period** (`+12.4%` / `-3 pts`) with semantic color + arrow.
- [ ] Context, not bare numbers: "vs last 30d", a tiny sparkline, or a target/goal bar. A number with no comparison is trivia.
- [ ] Progressive disclosure: KPIs → trend charts → detail tables → raw rows. Top of page = summary, scroll = depth. See the **visual-hierarchy** section.
- [ ] One primary action per view (Create, Export, Drill in). Don't scatter 6 equal buttons.

### Layout: shell, grid, anatomy

- [ ] Page shell: persistent **left sidebar** (primary nav) + **top bar** (global search, date-range, account). Content area is a card grid.
- [ ] Everything on the **8pt grid**; 12-col layout, 24px gutters. KPI row = 4 equal cards; below, 2/3 + 1/3 splits. See the **spacing-and-layout** section.
- [ ] Consistent **card anatomy** every widget repeats: title (+ optional info tooltip) · primary value · trend/delta · chart/sparkline · footer action ("View all →"). Same order, same paddings.
- [ ] Card padding 16-24px; never let charts bleed to the card edge. Group related cards; whitespace between groups does the sectioning.
- [ ] Don't reinvent per widget — one Card primitive, one header pattern, one menu (kebab) for per-widget actions.

### Data density done right

- [ ] Tight but breathable: dense enough to compare without scrolling, never crammed. Whitespace is still a feature, not waste.
- [ ] Offer a **density toggle** — Comfortable (default) and Compact — and persist the choice. Power users live in Compact.
- [ ] Scannable alignment: numbers right-aligned with `tabular-nums`; labels left; consistent decimal places per column.
- [ ] Cap visible widgets per screen (~6-9 above the fold). If you need 20, that's tabs or separate pages, not one scroll.

### Data viz restraint

- [ ] Match chart to job: **line** = trend over time, **bar** = compare categories, **single number** = KPI, **table** = exact detail, **stacked/area** only for part-to-whole over time.
- [ ] Ban chartjunk: no 3D, no gradients-as-decoration, no drop shadows on bars, no dual Y-axes, no **pie charts >5 slices** (use a bar).
- [ ] Always label axes and units; start bar-chart Y at **0** (truncating lies). Annotate the latest/anomalous point, not every point.
- [ ] **Consistent color mapping** across the whole dashboard: a series ("Pro plan") is the same hue in every chart. Sequential data → one perceptual ramp.
- [ ] Reserve **semantic status** (success/warning/error) for status only, used sparingly — not as a generic palette. See the **color-system** section.
- [ ] Max ~5-6 series per chart; beyond that, split or let the user toggle series.

### Tables

- [ ] Most dashboards need a great table for the detail layer — don't hand-roll it. Defer to the **data-tables** section for alignment, density, sticky header, sort/filter, pagination.
- [ ] From a KPI or chart, link **into** the filtered table ("show the 312 orders behind this number"). Drill-down is the payoff of a summary.

### States — every widget, independently

- [ ] **Loading**: skeleton matching the card's final shape (not a centered spinner, not layout shift). Stagger so the page doesn't strobe.
- [ ] **Empty**: explain why it's empty + the next action ("No data for this range — widen the date range"). Never a blank box.
- [ ] **Error**: scope failure to the **one widget** — a card-level retry, not a white-screened page. Partial failure must not kill the dashboard.
- [ ] **Stale/partial**: timestamp ("Updated 2m ago") and flag degraded data. See the **loading-empty-error-states** section.

### Filtering & controls

- [ ] **Global** filters in the top bar (date-range, environment, segment) apply to every widget; **per-widget** controls (this chart's granularity) live in the card.
- [ ] Date-range is the master control of most dashboards — make it prominent, with presets (7d / 30d / QTD) + custom.
- [ ] **Encode filter state in the URL** (query params) so views are shareable, bookmarkable, and survive reload.
- [ ] Show **active-filter chips** with individual ✕ and one "Clear all". The user must always see what's narrowing the data.

### Dark mode + density are table stakes

- [ ] Ship **light and dark** from the start, driven by tokens — not bolted on. Charts, borders, and elevation all need dark variants. See the **color-system** section.
- [ ] In dark mode, signal elevation with lighter surfaces, not heavy shadows; keep chart series legible on the dark background (re-check contrast).
- [ ] Density toggle + theme toggle both persist across sessions.

### Verify before done

- [ ] `browser_check` at **desktop (~1440px)** and **narrow (~768px and ~375px)**: sidebar collapses to icons/drawer, KPI cards reflow to 2-up then 1-up, charts stay readable, no horizontal scroll. See the **responsive-design** section.
- [ ] First-second test: can you name the top metric and its trend instantly? If not, sharpen hierarchy.
- [ ] Toggle each widget through loading / empty / error; kill one data source and confirm the rest of the page survives.
- [ ] Check light + dark, comfortable + compact. Confirm filter state round-trips through the URL.

---

## Screenshot Critique Loop

You cannot judge a UI you have not seen. Code that compiles is not a UI that looks right — alignment, rhythm, hierarchy, and slop are invisible in the diff and obvious in a screenshot. After building ANY visual UI, render it and look before you say "done". This is the self-correcting build → look → critique → fix loop. For a full audited pass, hand off to the **design-review** section; this loop is your own fast feedback during the build.

### The loop (cap 3–5 iterations)

1. **Locate the running app.** Reuse a live server; only `run_bash` a new one (`npm run dev`) if none is up. Grab the exact URL + route for the view you just built.
2. **Render + capture.** `browser_check` navigate to the route, then screenshot. No screenshot = no judgment; never declare done from code alone.
3. **Critique against the brief.** Score the screenshot on the rubric below (1–5 each). Reread the brief/reference with `read_file` first so you grade against intent, not vibes.
4. **List specific diffs.** Write concrete deltas — "CTA is 14px, brief wants the hero dominant; bump to ~20px/700 and add an accent fill" — never "make it nicer" or "polish it".
5. **Fix the top issue.** `edit_file`/`write_file` the highest-impact problem first (lowest rubric score). One focused change per pass beats five scattered ones.
6. **Re-shoot + compare.** `browser_check` screenshot again; diff against the previous shot. Confirm the fix landed and broke nothing.
7. **Repeat or stop.** Loop to 3 until the bar is met OR gains plateau (a pass that moves no score ≥1 point). Stop at 5 iterations regardless — re-evaluate the approach instead of thrashing.

### Every pass: breakpoints + states

- Capture all three widths each pass — `browser_check` resize to **1440** (desktop), **768** (tablet), **375** (mobile). Reject horizontal scroll, overlap, clipped text, collapsed layout. See the **responsive-design** section.
- Capture interaction states: **hover** and **focus** on the primary control (visible focus ring, ≥3:1).
- Capture the **empty / loading / error** states, not just the happy path — see the **loading-empty-error-states** section.

### Critique rubric (score 1–5, attack the lowest)

- **Hierarchy / focal point** — squint test: one region dominates in <1s, the CTA is findable blurred. the **visual-hierarchy** section.
- **Spacing & alignment** — 8px rhythm, consistent gaps, hard edges align; no orphaned or random margins. the **spacing-and-layout** section.
- **Type scale & pairing** — ≥1.5× steps between tiers, ≤2 families, sane line-height/measure (45–75ch).
- **Color & contrast** — accent used once, neutrals carry the rest, body text ≥4.5:1.
- **Depth & polish** — intentional shadows/borders/radius; nothing flat-and-cheap or over-decorated.
- **AI-slop tells** — generic gradient hero, emoji bullets, three equal cards, centered everything, default shadcn untouched. the **anti-slop** section.
- **Looks like the SUBJECT** — does it read as *this* product/brand, or as a generic template? the **frontend-design** section.

### Reference compare (if a reference exists)

1. `web_fetch` the reference URL, or screenshot the supplied mock with `browser_check`.
2. Place reference and build side by side; diff hierarchy, spacing scale, type, color, density.
3. Name specific gaps — "ref hero is 96px/800, mine 32px/600; ref uses 2-col asymmetric, mine 3 equal cards".
4. Feed the named gaps back into step 4 as concrete diffs.

### Discipline

- Problems over prescriptions: state what is wrong and its impact; pick the fix deliberately.
- Highest-impact first: fix the lowest rubric score before any nitpick.
- Stop when the bar is met — over-polishing past the brief is wasted iteration and risks regressions.
- Don't trust memory of how it "should" look — trust the latest screenshot.
- Record durable standards (breakpoint set, contrast floor, brand accent) with `memory_add`.

### Output

Emit an iteration log, one block per pass, then a verdict:

```
Pass 1 — shot: home-1440.png, home-375.png
  scores: hierarchy 2, spacing 3, type 4, color 3, depth 2, slop 2, subject 2
  top-3: (1) no focal point — 3 equal cards; (2) generic gradient hero (slop);
         (3) flat, no depth. fix: rebuild hero asymmetric, kill gradient.
Pass 2 — shot: home-1440.png …
  scores: hierarchy 4, spacing 4, type 4, color 4, depth 3, slop 4, subject 4
  top-1: depth still thin on cards. fix: add 1px border + sm shadow.
```

End with **PASS** (every rubric line ≥4 at all 3 breakpoints, states covered) or **FAIL** (list what blocks it). On FAIL within the iteration cap, loop; if the cap is hit, escalate to the **design-review** section.

### Checklist

- [ ] App running; correct route + URL
- [ ] `browser_check` screenshot at 1440 / 768 / 375 this pass
- [ ] Hover, focus, empty, loading, error captured
- [ ] Rubric scored; lowest line identified
- [ ] Concrete diffs listed (no vague "nicer")
- [ ] Top issue fixed via `edit_file`; re-shot and compared
- [ ] Looped ≤5× to PASS or plateau
- [ ] Iteration log + final PASS/FAIL recorded

---

## Design Review

Review the **already-built, running UI** in the browser — the visual counterpart to code review. Use `browser_check` to navigate, screenshot, and resize. You critique the live experience, not the diff.

### Setup
- Confirm the app is running; get the URL from the change/PR or `run_bash` (e.g. `npm run dev`). Do not start a second server if one is up.
- Review at three widths: **1440px** (desktop), **768px** (tablet), **375px** (mobile). `browser_check` resize before each pass.
- Screenshot **every** finding — a claim without an image is not a finding.

### 7 phases (run in order)
1. **Preparation** — read the change/PR intent and the original brief with `read_file` first. Know what "done" means before you look.
2. **Interaction & user flow** — click the primary path end to end. Hover, focus, submit, navigate. Note dead ends, surprises, broken states.
3. **Responsiveness** — screenshot at 1440 / 768 / 375. Reject any horizontal scroll, overlap, clipped text, or collapsed layout. See the **responsive-design** section.
4. **Visual polish** — spacing rhythm, alignment, type scale, color, contrast, hierarchy. Cross-check the **spacing-and-layout** section, the **typography** section, the **color-system** section, the **visual-hierarchy** section, the **anti-slop** section.
5. **Accessibility** — WCAG 2.1 AA: keyboard-only nav, visible focus ring, text contrast ≥ 4.5:1, touch targets ≥ 44px, every input labeled. Defer detail to the **accessibility** section; confirm color via `diagnostics` or the **design-tokens** section.
6. **Robustness** — paste a 200-char string into every field/label; force overflow; trigger empty, loading, and error states. See the **loading-empty-error-states** section and the **forms-and-inputs** section.
7. **Code health** — only after the visual pass. `read_file` the changed components: design tokens vs hardcoded hex/px, reused components vs one-offs. See the **design-tokens** section, the **component-states** section, the **tailwind-and-shadcn** section.

### Triage every finding
Label each one exactly:
- **[Blocker]** — broken, unusable, or fails AA. Ship-stopping.
- **[High-Priority]** — significant UX or polish defect; fix before merge.
- **[Medium]** — should fix soon; not blocking.
- **[Nitpick]** — minor; prefix the line with `Nit:`.

### Do
- Start the report with **what works** — name 2-3 things done well.
- Describe the **problem and its user impact**; let the author choose the fix.
- Attach a screenshot ref to every finding, scoped to the breakpoint where it appears.
- Assume the author is competent and made considered choices; ask before assuming a mistake.
- Use `web_search` only to confirm a WCAG/spec number you are unsure of — not for design opinions.

### Don't
- Don't prescribe code or exact values ("describe problems, not prescriptions").
- Don't report a finding you cannot screenshot.
- Don't skip a breakpoint because the desktop view looked fine.
- Don't restyle or "fix" things yourself — this skill reviews, it does not build (that's the **frontend-design** section).
- Don't pad with subjective taste dressed as fact.

### Output
A report grouped by the 7 phases, in order. Under each phase, bullet the findings with their triage label and screenshot ref:

```
What works
- Clean type scale; consistent 8px spacing rhythm; fast first paint.

Phase 3 — Responsiveness
- [Blocker] Nav overlaps logo at 375px, links unreachable. (shot: mobile-nav.png)
- [Medium] Card grid keeps 3 columns at 768px, cramped. (shot: tablet-grid.png)

Phase 5 — Accessibility
- [High-Priority] Primary button text 3.1:1 on the brand fill, below 4.5:1. (shot: btn-contrast.png)
- Nit: Focus ring invisible on dark cards. (shot: focus-dark.png)
```

End with a one-line verdict: ship / fix-then-ship / blocked.

### Persist
When a finding reveals a durable UX standard for this codebase (a fixed breakpoint set, a contrast floor, a token rule), record it with `memory_add` so future reviews start from it.

### Related
the **screenshot-critique-loop** section · the **dashboard-design** section · the **landing-page-design** section · the **data-tables** section · the **motion-and-animation** section · the **depth-and-imagery** section

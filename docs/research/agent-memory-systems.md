# Token-Efficient Memory Systems for AI Agents

> Research compiled 2026-06-19. Topic: how to design an agent memory system that is SUPER
> efficient and token-efficient — maximizing useful recall while minimizing tokens injected
> into context.
>
> **Method:** Deep-research workflow — 18 sources fetched (heavily primary: arXiv papers,
> Anthropic docs, vendor research pages), 88 claims extracted, 25 adversarially verified.
> **25/25 confirmed, 0 killed** (a clean run). Quantitative *quality* claims flagged with
> skepticism where vendor-self-reported.

---

## TL;DR — the one principle that matters

**Treat context as a scarce "attention budget" and inject as few tokens per turn as
possible.** The winning design is *just-in-time + tiered*: keep a tiny always-loaded index
plus lightweight identifiers (file paths, queries), store the bulk of memory **outside** the
context window, and pull in only the **top-k most relevant** items on demand. Every token you
add degrades recall ("context rot"), so the goal is the *smallest relevant subset*, not the
biggest memory.

---

## 1. The mechanistic "why" (foundational, well-corroborated)

Anthropic's context-engineering guidance gives the rationale, and it's independently confirmed:

- **Context rot:** as token count rises, the model's ability to accurately recall information
  from context *decreases*. (Corroborated by Chroma across 18 frontier models; Liu et al.
  "Lost in the Middle" — >30% degradation across 6 model families; Stanford 2023.)
- **Attention budget:** transformers have n² pairwise attention, and training skews toward
  shorter sequences — so every token "depletes" a finite attention budget.

> **Design consequence:** more memory in context is *not* better. Past a point it actively
> hurts. This is the entire justification for token-efficient memory.

---

## 2. The core architectural patterns (and their recall-vs-token tradeoff)

### A. Just-in-time / lazy context loading — *Anthropic's core principle*
Keep **lightweight identifiers** (file paths, stored queries, links) in context; load actual
data at runtime via tools. Claude Code uses targeted queries + Bash `head`/`tail` to inspect
large data without loading whole objects.
- **Important nuance:** Anthropic recommends a **hybrid**, not pure JIT — retrieve *some* data
  up front for speed, then explore autonomously. "Runtime exploration is slower than
  retrieving pre-computed data."

### B. Hierarchical / tiered "virtual memory" — *MemGPT / Letta (arXiv 2310.08560)*
OS-inspired **virtual context management**: move data between fast (in-context/main) and slow
(external) memory to simulate a context window larger than the physical limit.
- **Recall storage** = frequently accessed message DB; **archival storage** = long-term,
  infrequently accessed text objects.
- A **FIFO queue** in main context manages overflow via **eviction**.
- This is *the* canonical tiered/paging memory pattern.

### C. Selective vector retrieval over a memory stream — *Generative Agents (Park et al. 2023)*
The foundational top-k pattern. Each memory is scored as a weighted sum (all weights = 1,
min-max normalized to [0,1]):
- **Recency** — exponential decay (factor 0.995)
- **Importance** — LM-generated 1–10 score at creation time
- **Relevance** — cosine similarity between the query embedding and the memory embedding

Only the **top-ranked memories that fit the context window** are injected. This *is* the core
token-efficiency mechanism — the full memory stream can't fit, so you retrieve a bounded subset.

### D. Reflection / memory consolidation — *Generative Agents*
Distill raw observations into **higher-level abstract memories**, triggered when summed
importance of recent events crosses a threshold (150 in their impl, ~2–3×/day), producing
recursive trees of reflections.
- **Ablation evidence it matters:** full architecture scored TrueSkill μ=29.89 vs
  fully-ablated μ=21.21 (Cohen's d=8.16); removing reflection alone dropped believability to
  μ=26.88. → Compression into fewer high-value tokens *improves* quality.

### E. Agentic / linked notes (Zettelkasten) — *A-Mem (arXiv 2502.12110)*
Construct structured notes (contextual descriptions, keywords, tags), **generate links**
between related memories, and **evolve/update** existing memories when new ones arrive.
- Selective top-k retrieval (k=10) ≈ **1,200 tokens/operation** vs ~16,900 for full-context
  baselines (LoCoMo, MemGPT) → **85–93% token reduction** (authors' self-reported).

### F. Memory-centric extraction + multi-signal retrieval — *Mem0 (arXiv 2504.19413)*
Dynamically **extract, consolidate, and retrieve salient facts** instead of loading full
history. A graph variant (Mem0g) captures relational structure.
- **Single-pass ADD-only fact extraction** (agent-generated facts as first-class).
- **Three parallel retrieval passes fused into one score:** semantic similarity + keyword
  (BM25) + entity matching.

---

## 3. The specific token-efficiency techniques (the toolbox)

| Technique | What it does | Source |
|---|---|---|
| **Top-k selective retrieval** | Inject only the few most relevant memories, not all history | Generative Agents, Mem0, A-Mem |
| **Lazy / on-demand loading** | Hold identifiers; read full content only when needed | Anthropic, Claude Code |
| **Tiered storage + eviction (FIFO)** | Page cold memory out of context; evict on overflow | MemGPT |
| **Compaction / summarization** | Summarize a near-full window, reinitialize with the summary (keep decisions/bugs, drop redundant tool output) | Anthropic |
| **Context editing / tool-result clearing** | Auto-evict stale tool calls/results near the token limit (API: `clear_tool_uses_20250919`, default 100K-token trigger, oldest-first, placeholder replacement) | Anthropic |
| **Reflection / distillation** | Compress raw observations into fewer high-value memories | Generative Agents |
| **Index + on-demand topic files** | Load a concise index; defer detail to files read on demand | Claude Code MEMORY.md |
| **Structured note-taking** | Agent writes notes (NOTES.md, to-dos) outside context, pulls back later | Anthropic |

---

## 4. How Claude Code / Anthropic operationalize this (the reference implementation)

This is the most concrete, citable example of the whole philosophy:

- **`CLAUDE.md` = an explicit token cost.** Loaded **in full at every session start**. Target
  **under 200 lines** — longer files reduce instruction adherence. ⚠️ `@path` imports do
  **NOT** save context: imported files also load at launch.
- **`MEMORY.md` (auto-memory, requires Claude Code v2.1.59+) = a concise index.** Only the
  **first 200 lines or 25KB (whichever comes first)** loads at conversation start. Content
  beyond that is **not loaded**.
- **Topic files** (`debugging.md`, `api-conventions.md`, `patterns.md`) are **NOT loaded at
  startup** — Claude reads them **on demand**. `MEMORY.md` acts as the index pointing to them.
- **File-based memory tool** (public beta, released ~Sept 29 2025 with Sonnet 4.5): Claude can
  **create/read/update/delete** files in a dedicated memory directory that persists across
  sessions, **entirely client-side** via tool calls — i.e., memory lives *outside* the context
  window.
- **Compaction + context editing** ship as the runtime pruning layer (see table above).

> This is the index-plus-on-demand-topic-files design in production — the canonical token-
> efficient memory architecture you can copy.

---

## 5. Empirical evidence — what's trustworthy vs. what's marketing

### Trustworthy (structurally near-tautological — selective retrieval *mechanically* beats reprocessing full history):
- **Mem0:** ~**91% lower p95 latency** (1.44s vs 17.12s) and **>90% token-cost savings**
  (~1.8K vs ~26K tokens/conversation); **<7,000 tokens/retrieval** vs 25,000+ for full context
  (~3–4× lower token cost).
- **A-Mem:** **85–93% token reduction** vs full-context baselines.
- **Anthropic 100-turn web-search eval:** context editing cut tokens **84%**; memory + context
  editing **+39%** over baseline, context editing alone **+29%**. *(Vendor-internal,
  non-reproducible — cite as a vendor benchmark, got 2-1 verifier votes.)*

### Treat skeptically (vendor self-reported accuracy on a contested benchmark):
- **Mem0:** claims **26%** relative LLM-as-Judge gain over OpenAI memory on LOCOMO (66.9% vs
  52.9%); overall **92.5** (LoCoMo) / **94.4** (LongMemEval).
- **Why skeptical:** **LOCOMO is contested.** Zep corrected a competing 84%→58.44% figure
  (getzep/zep-papers #5); SimpleMem reports Mem0 F1 34.20 vs its own 43.24; LOCOMO's
  16k–26k-token conversations *fit in modern context windows* and have noted gold-answer
  quality issues. **No neutral leaderboard establishes a clear quality-per-token winner.**

### A useful negative result:
- Mem0's own paper notes the **graph variant (Mem0g) costs ~2× tokens and ~3× slower search
  for only ~2% LOCOMO gain** → knowledge-graph memory may *not* be token-efficient vs plain
  vector retrieval.

---

## 6. Practical design principles (how to build a SUPER token-efficient memory)

1. **Default to a small always-loaded index + everything else on demand.** (Claude Code's
   MEMORY.md model.) Keep the index concise; defer detail to topic files.
2. **Retrieve top-k, not all.** Bound what enters context per turn; score by
   relevance + recency + importance (Generative Agents).
3. **Externalize the bulk.** Persist long-term memory in files/DB outside the window; hold
   only lightweight identifiers in context.
4. **Prune aggressively at runtime.** Compaction (summarize + reinitialize) and context
   editing (evict stale tool results) keep the window lean over long sessions.
5. **Consolidate/reflect to compress.** Distill raw observations into fewer high-value
   memories — improves quality *and* saves tokens.
6. **Be wary of knowledge graphs for token efficiency.** They add relational power but can
   cost 2× tokens for marginal accuracy gains.
7. **Measure efficiency, trust efficiency numbers more than accuracy numbers.** Token/latency
   savings are structurally robust; "best memory system" accuracy rankings are not.

---

## Caveats & coverage gaps

- **Vendor self-report bias** dominates the *quality* numbers (Mem0's 26%/92.5/94.4;
  Anthropic's 39%/29%/84%). All on benchmarks the vendors chose. The **token/latency**
  efficiency numbers are far more trustworthy (near-tautological).
- **2-1 votes** (directionally sound, minor imprecision): MemGPT FIFO-queue location detail,
  A-Mem's token-reduction magnitude, both Anthropic context-editing benchmarks.
- **Time-sensitive:** Anthropic's memory tool + context editing are public beta as of mid-2026;
  Claude Code auto-memory needs v2.1.59+; Mem0 scores updated Apr–May 2026.
- **Coverage gap:** the run did **not** surface verified primary-source detail for **Zep/
  Graphiti, Cognee, LangMem, Memary, or txtai**, nor concrete GitHub star counts. Those parts
  of the question remain open — worth a targeted follow-up run.

## Open questions worth a follow-up
- Mechanisms + popularity for Zep/Graphiti, Cognee, LangMem, Memary, txtai (unfilled).
- How systems compare under **independent** third-party benchmarks (vendor cross-disputes
  suggest no neutral winner).
- Quantified **recall cost of forgetting** — sources describe eviction/dedup mechanisms but
  rarely measure how much recall is lost.

---

## Sources

**Primary — papers:**
- MemGPT / Letta — https://arxiv.org/abs/2310.08560
- Mem0 — https://arxiv.org/abs/2504.19413 · https://mem0.ai/research
- A-Mem — https://arxiv.org/pdf/2502.12110 · https://github.com/agiresearch/A-mem
- Generative Agents (Park et al. 2023) — https://arxiv.org/abs/2304.03442 · https://3dvar.com/Park2023Generative.pdf

**Primary — Anthropic / Claude Code:**
- Effective Context Engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Context Management (news) — https://www.anthropic.com/news/context-management
- Memory tool docs — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Context editing docs — https://platform.claude.com/docs/en/build-with-claude/context-editing
- Claude Code memory docs — https://code.claude.com/docs/en/memory

**Skeptical / cross-check:**
- Zep: "Is Mem0 really SOTA?" — https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- LOCOMO correction — https://github.com/getzep/zep-papers/issues/5
- Controlled coding-agent memory benchmark — https://medium.com/@mrsandelin/the-first-controlled-benchmark-of-ai-memory-in-coding-agents-8e0bb776d39e

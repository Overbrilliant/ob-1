# Advanced & "Very Visible" Memory Systems

> Research compiled 2026-06-19. Topic: advanced, transparent, inspectable memory architectures
> — the ones you can *see, audit, visualize, and edit* — beyond plain markdown or opaque vector
> blobs. Triggered by "make it very visible… like by Google."
>
> **Method:** Deep-research workflow — 26 sources fetched (Google Cloud/Vertex docs, ADK docs,
> Graphiti & Mem0 papers, OpenAI docs, repos), 124 claims extracted, 25 adversarially verified.
> **25/25 confirmed, 0 killed.**
>
> Companion to [agent-memory-systems.md](agent-memory-systems.md) (R3) and the
> markdown-vs-DB decision discussed in chat.

---

## TL;DR — "visible memory" is three different things

"Make memory visible" splits into three families. The key finding: **the cheapest, most robust
way to get visible memory is NOT a graph — it's transparent natural-language facts + an audit
trail** (exactly Google's model). Graphs are the most *visualizable* but cost ~2× tokens for ~2%
accuracy.

| Family | What "visible" means | Examples | Cost |
|---|---|---|---|
| **Transparent fact store** | Memory is human-readable text you can read + version | **Google Memory Bank**, A-MEM notes | low |
| **Knowledge graph** | Memory renders as an entity/relationship graph | **Zep/Graphiti**, Cognee, Mem0g | **high (~2× tokens, ~3× latency)** |
| **User-editable memory UI** | The user can see/edit/delete saved memories | ChatGPT Memory, Gemini Saved info, Letta blocks | low |

> **For OB-1 (single-dev CLI agent): adopt Google's data model on top of our markdown +
> sqlite-vec plan** — store each memory as a plain-text `fact` with `scope` + immutable
> `revisions`. That delivers "very visible" (readable + versioned + auditable) *without* paying
> the graph tax. Defer a real temporal knowledge graph to an optional advanced tier.

---

## Family 1 — Google: transparent facts + audit trail (the "by Google" you saw)

### Vertex AI Agent Engine **Memory Bank**
The cleanest model of visible memory. **Each memory is a human-readable natural-language fact**,
not a vector:
```json
{ "name": "projects/.../memories/...",
  "scope": { "agent_name": "My agent", "user": "my user ID" },
  "fact": "I prefer aisle seats on flights." }
```
- **Embeddings are only an optional retrieval index over the text facts — not the stored
  representation.** The stored thing is always the readable sentence.
- **LLM-managed evolution (Gemini):** extracts only topic-matching, meaningful info; **consolidates**
  with existing same-scope memories — create / update / delete, with **dedup + contradiction
  checks** before merging. Memory *evolves* rather than piling up.
- **Two retrieval modes:** return all (simple) or similarity-search top relevant.
- **Scoped per user** — memories never leak across identities.
- **⭐ Immutable `revisions` = the visibility killer feature:** every create/update/delete saves a
  new immutable revision, so you can **inspect how a memory transformed over time**, with
  **rollback** (`RollbackMemory` → `target_revision_id`). This is a full audit trail. *(Preview;
  bounded retention, e.g. ~365-day TTL.)*

### Google **ADK** memory services
Clean two-tier separation (mirrors our hot/cold tiers):
- **Sessions / State** = short-term memory for one chat.
- **MemoryService** = searchable long-term archive across many chats. Interface
  `BaseMemoryService` with `add_session_to_memory` + `search_memory`.
- Two backends spanning the transparency↔durability axis:
  - **`InMemoryMemoryService`** — plain in-RAM, keyword match, no setup, no persistence →
    transparent, for prototyping.
  - **`VertexAiMemoryBankService`** — LLM extraction + consolidation, semantic search → production.

---

## Family 2 — Knowledge graphs: maximally visualizable, but costly

### Zep / **Graphiti** (temporal knowledge graph — arXiv 2501.13956)
The "render it as a graph" approach.
- Memory = **entity nodes** (with summaries that evolve) + **fact/relationship edges** as
  triplets (Entity → Relationship → Entity). Renders directly in graph viewers (stored in Neo4j).
- **Bi-temporal model:** facts carry validity windows (`t_valid`/`t_invalid`) plus transaction
  time. When info changes, old facts are **invalidated, not deleted** → you can query **"what was
  true at any point in time."** This temporal reasoning is graph memory's real differentiator.
- **Incremental, real-time** integration (vs GraphRAG's batch recompute); **hybrid retrieval**
  (semantic + BM25 + graph traversal).
- ⚠️ Zep's benchmark claims (LongMemEval +18.5% accuracy / 90% latency reduction) are
  **vendor self-reported**, one subcategory *regresses* (−17.7%), and its LoCoMo 84% claim is
  disputed by Mem0. Treat superiority numbers skeptically.

### Cognee, A-MEM
- **Cognee** (Apache-2.0): self-hosted knowledge-graph engine unifying graph + vector +
  relational via an ECL (Extract-Cognify-Load) pipeline; **natively visualizable** (renders to
  interactive HTML; Neo4j/NetworkX/FalkorDB backends).
- **A-MEM** (arXiv 2502.12110): Zettelkasten notes — each memory stores `{content, timestamp,
  LLM keywords, tags, contextual description, embedding, links}`. The natural-language attributes
  live *alongside* the embedding, so content stays inspectable. (Built on ChromaDB — augments
  vectors, doesn't replace them.)

### ⚠️ The graph tax (the skeptical core — Mem0's own paper)
Mem0 measured its *own* graph variant vs its base:

| Metric | Base Mem0 | Graph (Mem0g) | Penalty |
|---|---|---|---|
| Tokens / conversation | ~7k | ~14k | **~2×** |
| Search latency (p50) | 0.148s | 0.476s | **~3.2×** |
| Overall accuracy | baseline | +~2% | marginal |

**Graph memory roughly doubles tokens and triples search latency for ~2% accuracy.** That's a
self-disclosed limitation (credible). *(Mem0 also measured Zep's graph at >600k tokens, but Zep
disputes that as misconfiguration — cite as "per Mem0's paper," not neutral fact.)*

---

## Family 3 — User-visible / editable memory

- **ChatGPT Memory:** two mechanisms — **saved memories** (user explicitly tells it; fully
  **inspectable / editable / deletable**) and **chat-history reference** (inferred from past
  chats; **NOT directly inspectable**). Visibility is partial: what you *told* it is visible;
  what it *inferred* is not.
- **Gemini "Saved info" / personalization:** user-visible saved facts + personal-context controls
  (the panel you likely saw).
- **Letta / MemGPT memory blocks:** transparent, editable in-context memory blocks the agent (and
  user) can read and rewrite — "memory as transparency." *(Letta sources were blog-tier and didn't
  fully clear the verification gate — directional.)*

---

## Visualization & observability tooling
- **Cognee** → interactive HTML graph export (color-coded nodes, labeled edges).
- **Graphiti** → Neo4j graph browser rendering.
- **Letta ADE** (Agent Development Environment), **Mem0 OpenMemory MCP**, `neo4j-labs/agent-memory`,
  community `memory-visualizer` — exist but were only partially verified; treat as leads.
- *(No single dominant "memory dashboard / diff-audit UI" standard emerged — a real gap.)*

---

## Recommendation for OB-1

The research validates the chat decision (markdown + sqlite-vec) and shows the *upgrade path to
"very visible"* without a graph:

1. **Adopt Google Memory Bank's data model locally.** Store each long-term memory as a
   structured record: `{ fact: "<plain text>", scope, created, revisions[] }`. Plain-text facts =
   readable; **immutable revisions = audit trail** ("how did this memory change?"). This is the
   single highest-value "visibility" feature and it's cheap.
2. **Keep sqlite-vec for top-k retrieval** over those facts (embeddings as *index only*, exactly
   like Memory Bank — the text remains the source of truth).
3. **Ship a `/memory` inspector** in the CLI: list, search, edit, delete, and *diff revisions* of
   what OB-1 remembers. Add an optional HTML/graph export (Cognee-style) for a visual view.
4. **LLM consolidation on write** (create/update/delete + dedup + contradiction check), like
   Memory Bank — so memory evolves instead of bloating (also fights R3's "context rot").
5. **Defer a temporal knowledge graph (Graphiti-style) to an optional advanced tier.** Justified
   *only* if OB-1 needs cross-session **temporal** reasoning ("what was the API shape 3 refactors
   ago?"). Until then the ~2×-tokens / ~3×-latency cost isn't worth ~2% — keep it off by default.

**Net:** markdown/JSON **fact records + revisions** (visible & auditable) → sqlite-vec (retrieval)
→ optional graph viewer (visualization) → optional temporal KG (advanced). Visibility first,
graph last.

---

## Caveats
- **Architecture/data-model claims are solid** (primary docs/papers). **Benchmark numbers are
  weak**: Zep's LongMemEval figures are vendor-authored, unreproduced, and partly regressive; the
  Mem0↔Zep token disputes are vendor-vs-vendor. The Mem0-vs-Mem0g internal comparison is credible
  (self-reported limitation).
- **Time-sensitive:** Google is rebranding "Agent Engine" → "Agent Runtime"/"Agent Platform";
  Memory Bank + revisions are **Preview** (TTLs/APIs may change); ADK docs moved to `adk.dev`.
- **No GitHub star counts** were captured for graphiti/cognee/A-mem/mem0/letta this run.
- **Visualization tooling** is only partially mapped — a dedicated memory diff/audit UI is an
  open gap.

## Open follow-ups
- Letta memory blocks & Microsoft GraphRAG inspectability/cost (named but unverified here).
- An **independent** (non-vendor) benchmark: text-facts + sqlite-vec top-k vs a temporal KG, for
  a coding agent specifically.
- Star counts for the graph-memory repos.

---

## Sources

**Primary — Google:**
- Memory Bank overview — https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/overview
- Generate memories — https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/generate-memories
- Memory revisions — https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/revisions
- Memory Bank blog (public preview) — https://cloud.google.com/blog/products/ai-machine-learning/vertex-ai-memory-bank-in-public-preview
- ADK memory — https://google.github.io/adk-docs/sessions/memory/ · https://adk.dev/sessions/memory/

**Primary — graph / temporal memory:**
- Graphiti — https://github.com/getzep/graphiti
- Zep paper (temporal KG) — https://arxiv.org/abs/2501.13956
- Mem0 paper (graph cost numbers) — https://arxiv.org/pdf/2504.19413
- Cognee — https://github.com/topoteretes/cognee · https://docs.cognee.ai/guides/graph-visualization
- A-MEM — https://arxiv.org/abs/2502.12110 · https://github.com/agiresearch/A-mem

**Primary — user-visible memory:**
- ChatGPT Memory FAQ — https://help.openai.com/en/articles/8590148-memory-faq
- Gemini personalization — https://docs.cloud.google.com/gemini/enterprise/docs/configure-personalization
- Letta memory blocks — https://www.letta.com/blog/memory-blocks

**Tooling / skeptical:**
- Neo4j × Graphiti — https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
- Graph-RAG vs vector-RAG memory — https://agentmarketcap.ai/blog/2026/04/07/graph-rag-vs-vector-rag-agent-memory-neo4j-pgvector
- Building local memory for coding agents — https://muhammadraza.me/2026/building-local-memory-for-coding-agents/

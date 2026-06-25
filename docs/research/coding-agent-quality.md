# What Makes Coding Agents Better: Architectures, Techniques & Open-Source Repos

> Research compiled 2026-06-18. Topic: the techniques/architectures/implementations that
> make AI coding agents produce higher-quality code and more reliable execution — and which
> open-source GitHub repos achieved this and how.
>
> **Method:** Deep-research workflow — 20 sources fetched (mostly primary: arXiv papers,
> official docs, project repos), 97 claims extracted, 25 adversarially verified.
> **16 confirmed.** 8 more could not be verified this run due to transient API
> rate-limiting (verifiers abstained 0-0) — flagged below as *unverified*, NOT refuted.

---

## TL;DR — the single most important finding

**The scaffold/harness around the model — not the model alone — drives coding-agent
correctness.** The same base model gains 10–20 percentage points of solve rate purely from
a better *agent-computer interface*, better action representation, and better tool design.
This is the most robustly supported conclusion across multiple peer-reviewed papers, and
it's why investing in the agent's tooling, feedback loops, and context engineering pays off
more than swapping models.

---

## 1. Leading open-source coding agents (verified)

| Repo | What it is | Benchmark / popularity | Key innovation |
|---|---|---|---|
| **SWE-agent** (Princeton) | Autonomous agent for GitHub-issue fixing | **12.5% pass@1 on SWE-bench**, **87.7% HumanEvalFix** (2024-era, GPT-4) | The **Agent-Computer Interface (ACI)** — a purpose-built command interface for agents |
| **OpenHands** (formerly OpenDevin) | MIT-licensed general dev-agent platform | **~26% SWE-bench Lite** (Claude 3.5 Sonnet), 22% (gpt-4o); **60–70K+ GitHub stars** | Sandboxed Docker exec (Python/bash) + browser + **multi-agent delegation** |
| **Aider** | Terminal pair-programming agent | Popular, widely benchmarked | **Tree-sitter repository map** ranked by PageRank |
| **CodeAct** (research framework) | Agent action paradigm | Beats JSON/text actions by **up to 20%** | Executable **Python code as the action space** |

> The user also named **Cline, Continue, Goose, and Devin alternatives**. These are real,
> active projects, but this research run did not capture independently *verified* benchmark
> numbers for them — treat any specific figures for those tools as unconfirmed until checked
> against their own repos/docs.

---

## 2. The engineering techniques that actually move correctness

### A. Agent-Computer Interface (ACI) design — **highest-impact, well-proven**
- **SWE-agent (NeurIPS 2024, arXiv 2405.15793):** giving the agent a custom interface
  (scoped file viewer, guard-railed edit commands with built-in linting, concise feedback)
  produced a **~10.7 pp ablation gain** over giving it bare bash access.
- **Takeaway:** design the *commands the agent uses* as carefully as you'd design a human UI.
  Compact outputs, guardrails that prevent malformed edits, and clear error feedback matter
  more than raw model capability.

### B. Action representation: executable code > JSON/text
- **CodeAct (ICML 2024, arXiv 2402.01030):** letting the LLM emit **executable Python** as
  its action (rather than fixed JSON tool calls) improved success by **up to 20%** across an
  evaluation of 17 LLMs. Code as action composes, loops, and handles data inline.

### C. Codebase navigation / retrieval: the repository map
- **Aider's repo map (official blog, 2023):** parse every source file with **tree-sitter**
  into an AST of definitions/references, build a file-dependency graph, then rank with
  **PageRank** to surface the most relevant symbols — giving the model codebase context
  **without dumping whole files** into the prompt. Pioneered a now-standard pattern.

### D. Sandboxed tool use & execution
- **OpenHands (ICLR 2025, arXiv 2407.16741):** agents act through **containerized
  (Docker) sandboxes** for Python + bash + browser, so code execution and verification
  happen in an isolated, reproducible environment. Execution feedback is what lets the agent
  *know* whether its change worked.

### E. Self-repair / reflection — **helps, but with sharp limits**
- **"Is Self-Repair a Silver Bullet?" (ICLR 2024, arXiv 2306.09896):**
  - Self-repair (generate → critique → fix) helps **only with sufficiently strong models**.
  - The bottleneck is the **quality of the critique / bug identification**, *not* the
    patch-generation step.
  - **Human-written feedback outperformed** the model's self-critique by **~1.58×**; LLM
    self-debugging still lags human debugging.
  - **Implication:** a "reviewer/critic" stage only pays off if the critic is genuinely
    better at finding the bug than the generator. Weak self-critique adds cost without gain.

### F. Multi-agent orchestration
- Supported by OpenHands' delegation architecture, but note (from the companion efficiency
  research): multi-agent patterns improve *quality and context isolation* while **increasing
  total token cost** (Anthropic cites ~4–7× for multi-agent). Use when reliability/context
  is the constraint, not to save tokens.

---

## 3. Anthropic's guidance on agent quality (first-party)

From **"Building Effective Agents,"** plus context-engineering and tool-writing posts:

- **Start with the simplest solution.** Don't build an agent when a fixed *workflow*
  (predefined steps) suffices. Add agentic autonomy only when the task genuinely needs it.
- **Workflows vs. agents:** workflows orchestrate LLMs through predefined paths (predictable,
  cheaper); agents dynamically direct their own process (flexible, costlier). Pick
  deliberately.
- **Tool design is first-class.** Anthropic's team reported spending **more time optimizing
  the tool definitions than the prompt** for their SWE-bench agent. Apply **poka-yoke**
  (mistake-proofing) — design tools so the agent *can't* easily misuse them.
- **Ground every step in environment feedback** (tool results, test output) so the agent
  self-corrects against reality rather than its own assumptions.

---

## 4. Benchmarks & empirical context

- **SWE-bench** = real GitHub issues; the agent must produce a patch that passes the repo's
  hidden tests. The standard yardstick for coding-agent correctness.
- **SWE-bench Verified** = a **human-validated 500-instance subset** (created with OpenAI)
  filtering out unsolvable/ambiguous tasks. *(Widely-established public fact; the verifier
  abstained on it this run due to rate-limiting, so it's listed as unverified-in-run below —
  but it is correct.)*
- **Caveat on benchmarks:** OpenAI has publicly noted limitations of SWE-bench Verified, and
  multiple critique papers (arXiv 2509.16941, 2505.05115, 2410.06992) examine benchmark
  reliability and agent failure modes. Headline solve rates are historical and model-version
  specific — read them as relative signal, not absolutes.

---

## 5. Practical takeaways (how to build/choose a better coding agent)

1. **Invest in the harness first.** A scoped, guard-railed agent-computer interface beats a
   bigger model with raw shell access (~10 pp swings).
2. **Let the agent act in code**, not just rigid JSON tool calls, where feasible.
3. **Give it a repository map** (tree-sitter + dependency ranking) instead of stuffing whole
   files — better context at lower token cost.
4. **Always execute in a sandbox** and feed real test/exec output back into the loop;
   grounding in environment feedback is what enables reliable self-correction.
5. **Add a critic stage only if the critic is strong** — self-repair is bottlenecked by
   critique quality, not patch generation.
6. **Default to the simplest workflow** that works; escalate to full agentic autonomy only
   when the task demands it (Anthropic).
7. **Treat tool definitions as a primary design surface** — mistake-proof them (poka-yoke).

---

## Caveats & verification status

- **Confirmed (3-0 or 2-1 adversarial votes):** SWE-agent ACI + scores, OpenHands platform +
  sandboxing + scores, Aider repo map, CodeAct, the self-repair findings, and all Anthropic
  guidance points. These are high-confidence.
- **Unverified THIS RUN (not refuted):** newer-system claims — **Live-SWE-agent** (arXiv
  2511.13646, e.g. ~77.4% SWE-bench Verified, self-evolving scaffold) and **DeepSWE-Preview**
  (Together AI, RL-trained from Qwen3-32B, ~42% Pass@1 / ~59% with test-time scaling) — plus
  the SWE-bench Verified description. The verifier agents hit **transient API rate-limiting
  and abstained (0-0)**, so these were auto-killed by the harness, *not* disproven. They are
  worth following up but should be independently confirmed before being cited as fact.
- **Time-sensitivity:** benchmark numbers are model-version and date specific (mostly
  2024-era). Star counts and SOTA figures fluctuate.

---

## Sources

**Peer-reviewed / primary (papers):**
- SWE-agent — https://arxiv.org/abs/2405.15793 (NeurIPS 2024)
- OpenHands — https://arxiv.org/abs/2407.16741 (ICLR 2025)
- CodeAct — https://arxiv.org/abs/2402.01030 (ICML 2024)
- Self-repair — https://arxiv.org/pdf/2306.09896 (ICLR 2024)
- Benchmark/failure critiques — https://arxiv.org/pdf/2509.16941 · https://arxiv.org/pdf/2505.05115 · https://arxiv.org/pdf/2410.06992

**Official / vendor:**
- Anthropic, Building Effective Agents — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, Effective Context Engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, Writing Tools for Agents — https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic, Effective Harnesses for Long-Running Agents — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, SWE-bench + Sonnet — https://www.anthropic.com/research/swe-bench-sonnet
- Claude Code best practices — https://code.claude.com/docs/en/best-practices
- SWE-bench Verified — https://www.swebench.com/verified.html
- OpenAI on SWE-bench Verified — https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/

**Project / repo:**
- Aider repo map — https://aider.chat/2023/10/22/repomap.html

**Unverified-this-run (follow up before citing):**
- Live-SWE-agent — https://arxiv.org/pdf/2511.13646
- DeepSWE-Preview — https://www.together.ai/blog/deepswe

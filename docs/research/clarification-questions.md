# Clarification / "ask-the-user" tools in coding agents

> **Scope & honesty:** this is a **design + landscape note**, not one of the 25-vote adversarially
> verified deep-research reports (#1–#8). It surveys how comparable agents let the model *ask the
> user a structured question mid-task*, and records the design OB-1 adopted (the `ask_user` tool).
> Product behaviours move fast and are version-gated — treat specifics as "as observed", not eternal.

---

## Why a structured ask beats guessing

The recurring finding across the quality research (reports #2, #6) is that **a wrong assumption is
expensive**: the agent burns tokens building the wrong thing, then more tokens undoing it. When a
task hinges on a decision only the human holds — a missing requirement, a fork between equally-valid
approaches, a preference (library, naming, scope) — the cheapest move is a *single, well-formed
question* rather than a guess or a vague "what would you like?" open prompt.

Two properties make such a question cheap to answer and cheap to parse:

1. **Selectable options** — the user picks with arrow keys / a click instead of typing. Lower
   friction, and the answer comes back as a known token the model can branch on cleanly.
2. **A free-text escape hatch** — a final "type your own" choice so the user is never boxed in when
   none of the options fit. Without it, a structured question becomes a trap and users abandon it.

This mirrors OB-1's standing UX preference: **arrow-key selection over typed arguments**, with typing
always available as a fallback.

## How comparable agents do it

| Agent | Mechanism | Options UI | Free-text fallback | Multi-select |
|---|---|---|---|---|
| **Claude Code** | `AskUserQuestion` tool | 1–4 labelled options per question, each with a short header "chip" | yes — an automatic "Other" that opens text entry | yes (per-question) |
| **Cline** (VS Code) | `ask_followup_question` tool | model supplies `<suggest>` options rendered as clickable buttons | yes — the chat input stays open for a typed reply | no (single suggestion set) |
| **Aider** | terminal confirm prompts (`y/n/all/skip`) | fixed verbs, not model-authored options | partial — some prompts accept a typed value | n/a |
| **Codex CLI / Gemini CLI** | approval/confirmation prompts | accept / reject / always | mostly fixed; edits via re-prompting | no |
| **Cursor / Copilot** | inline natural-language follow-ups | none (free prose) | yes (it's all free text) | n/a |

**What's converging:** the strongest pattern (Claude Code, Cline) is a *first-class tool* that takes
a **question + a short list of model-authored options**, renders them as a pick list, and **always
leaves an "other / type your own" path**. The terminal-confirm style (Aider/Codex) is really a
narrower special case — a fixed yes/no/all question with no model-authored choices.

Lighter agents (Cursor-style inline questions) skip structure entirely; that's lowest-effort to build
but pushes parsing back onto the model and gives the user no quick-pick affordance.

## Design adopted in OB-1 — the `ask_user` tool

A read-only tool (no approval gate; allowed in Plan mode) that the model calls when a decision is
genuinely the user's to make. It takes a **group of questions** (like Claude Code's `AskUserQuestion`)
— usually one, but the agent may batch a few independent decisions:

- **`questions[]`** — 1–4 questions, presented in turn (a "(1/3)" counter shows when batched). Each:
  - **`question`** — the prompt.
  - **`header`** — optional 1–3 word topic chip (mirrors Claude Code's headers).
  - **`options[]`** — 2–4 short, distinct `{label, description?}` choices (string shorthand accepted).
  - **`multi_select`** — `false` ⇒ **radio buttons** (choose one); `true` ⇒ **checkboxes** (choose any).
- **An always-present final row per question — "Something else (type your own)"** — the free-text
  escape hatch.

The tool is forgiving: a single top-level `question`+`options` (no `questions` wrapper) is accepted
too, option lists are capped at 6 and the group at 4, and a question missing text or options is
dropped rather than shown.

**UI surfaces (both front-ends):**
- *TUI (Ink):* arrow-key list with radio `(•)` / checkbox `[x]` markers, `Space` to toggle in
  multi-select, `Enter`/`→` to select-or-confirm, and the free-text row opening an inline text input.
  `←`/`Esc` dismiss. Rendered in its own bordered panel; the busy spinner is hidden while it owns the
  frame; `Esc` during the question dismisses *it*, not the running turn.
- *REPL (non-TTY):* prints the question + numbered options and reads one line — a number (or
  comma-separated numbers when multi) picks options, anything else is taken as the free-text answer.

The tool returns a single human-readable answer string ("The user answered: …"), so the model gets a
clean, unambiguous result to continue from. The system prompt nudges the model to **prefer asking
over guessing when a wrong assumption would waste work — but not to ask when a sensible default is
obvious** (over-asking is its own failure mode).

## Guidance distilled

1. **Make it a tool, not prose** — structured options + a known-shape answer beat open-ended prose.
2. **Always include "type your own"** — never trap the user in a fixed list.
3. **Radio by default, checkbox on request** — most clarifications are single-choice.
4. **Keep it to 2–4 options** — more is a sign the question should be split or is premature.
5. **Don't over-ask** — a clarifying question has a cost too; skip it when a default is obvious and
   state the assumption instead. (Echoes the wider thesis: spend tokens only where they buy value.)
6. **Selection over typing**, with typing always one keystroke away.

---

*Design note added 2026-06-21 alongside OB-1's `ask_user` implementation. Landscape rows are "as
observed" and version-sensitive; the OB-1 section is authoritative for this repo.*

// Secrets handling (gap 8.6). A session-scoped secret store: the agent requests a credential by name,
// the user supplies the value through a masked prompt (never typed into the transcript), and the value is
// exposed to run_bash child processes as an environment variable — never returned to the model, never
// written to disk, never logged. `redact()` lets callers scrub any accidental echo of a value out of tool
// output. This is the "request a key; never log or commit secrets" capability Devin (list_secrets /
// request_auth) and Replit (ask_secrets) have and OB-1 lacked.

/** Env-var naming: UPPER_SNAKE, leading letter. Keeps a requested name from clobbering arbitrary process
 *  state (PATH, HOME) or injecting shell-unsafe characters. */
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** A masked input callback wired by the interactive host (TUI/REPL). Returns the entered value, or null
 *  if the user cancelled. Absent in non-interactive contexts (subagents, smokes, piped input). */
export type SecretPrompt = (name: string, reason?: string) => Promise<string | null>;

export class SecretStore {
  private vals = new Map<string, string>();
  constructor(private opts: { prompt?: SecretPrompt; exposeEnv?: boolean } = {}) {}

  static validName(name: string): boolean { return NAME_RE.test(name); }

  /** Set is wired to interactive input; promote to process.env (default on) so run_bash children inherit it. */
  set(name: string, value: string): void {
    this.vals.set(name, value);
    if (this.opts.exposeEnv !== false) process.env[name] = value;
  }

  /** Known to this session — either supplied this session OR already present in the environment. */
  has(name: string): boolean {
    return this.vals.has(name) || (typeof process.env[name] === "string" && process.env[name] !== "");
  }

  /** Where the value lives, for an honest status line (never the value itself). */
  source(name: string): "session" | "env" | "missing" {
    if (this.vals.has(name)) return "session";
    if (typeof process.env[name] === "string" && process.env[name] !== "") return "env";
    return "missing";
  }

  /** Names known this session (env-only secrets aren't enumerable here by design). */
  names(): string[] { return [...this.vals.keys()]; }

  /** Replace any occurrence of a stored secret value with a mask — defense against an accidental echo. */
  redact(text: string): string {
    let out = text;
    for (const v of this.vals.values()) if (v && v.length >= 4) out = out.split(v).join("‹redacted›");
    return out;
  }

  /** Request a secret by name via the wired masked prompt. Idempotent: if already set, returns false
   *  (didn't prompt). Throws on a bad name. Returns true when a value was newly captured. */
  async request(name: string, reason?: string): Promise<boolean> {
    if (!SecretStore.validName(name)) throw new Error(`invalid secret name "${name}" — use UPPER_SNAKE_CASE (e.g. OPENAI_API_KEY)`);
    if (this.has(name)) return false;
    if (!this.opts.prompt) throw new Error(`no interactive prompt available to enter ${name}; set it in the environment before running (e.g. export ${name}=…) and it will be picked up`);
    const v = await this.opts.prompt(name, reason);
    if (v == null || v === "") return false; // cancelled / empty → leave unset
    this.set(name, v);
    return true;
  }
}

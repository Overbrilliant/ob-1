// Eval tasks (Phase 7). SWE-bench-shaped at small scale: each task is a self-contained coding
// problem graded by an OBJECTIVE check command (exit 0 = PASS) run against the candidate's
// extracted code — the same `$OB1_FILE` contract Fusion uses. No model-as-judge: grading is
// deterministic, which is what lets the harness keep everyone honest (R5).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface EvalTask {
  id: string;
  prompt: string;   // given verbatim to each mode
  check: string;    // shell command; $OB1_FILE = path to the candidate's extracted code; exit 0 = PASS
  lang?: string;    // extraction/scoring hint
}

/** Two starter tasks with precise specs + discriminating checks. Add more under eval/tasks/*.json. */
export const BUILTIN_TASKS: EvalTask[] = [
  {
    id: "sum-evens",
    lang: "ts",
    prompt:
      "Implement and export a TypeScript function `sumEvens(nums: number[]): number` that returns the " +
      "sum of all even numbers in the array. Negative evens count normally (e.g. -4 is even); an empty " +
      "array returns 0. Use a named `export`. Output ONLY the complete file as a single fenced TypeScript code block.",
    check:
      'bun -e \'const m=await import(process.env.OB1_FILE);const f=m.sumEvens??m.default;' +
      'if(typeof f!=="function")process.exit(2);' +
      'const eq=(a,b)=>{if(a!==b){console.error(a+" != "+b);process.exit(1)}};' +
      'eq(f([1,2,3,4,6]),12);eq(f([]),0);eq(f([1,3,5]),0);eq(f([2,-4,7]),-2);\'',
  },
  {
    id: "slugify",
    lang: "ts",
    prompt:
      "Implement and export a TypeScript function `slugify(s: string): string` that returns a URL slug: " +
      "trim, lowercase, replace every run of non-alphanumeric characters with a single hyphen, and strip " +
      'leading/trailing hyphens. Examples: "Hello World" -> "hello-world"; "  A__B  " -> "a-b"; ' +
      '"foo!!!bar" -> "foo-bar"; "--x--" -> "x". Use a named `export`. Output ONLY the complete file as a ' +
      "single fenced TypeScript code block.",
    check:
      'bun -e \'const m=await import(process.env.OB1_FILE);const f=m.slugify??m.default;' +
      'if(typeof f!=="function")process.exit(2);' +
      'const eq=(a,b)=>{if(f(a)!==b){console.error(a+" => "+f(a)+" != "+b);process.exit(1)}};' +
      'eq("Hello World","hello-world");eq("  A__B  ","a-b");eq("foo!!!bar","foo-bar");eq("--x--","x");eq("Already-Slug","already-slug");\'',
  },
];

/** Built-in suite + any extra task JSON (one object or an array per file) under `<cwd>/eval/tasks/`. */
export function loadTasks(cwd: string): EvalTask[] {
  const tasks = [...BUILTIN_TASKS];
  const dir = join(cwd, "eval", "tasks");
  if (!existsSync(dir)) return tasks;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const t of Array.isArray(parsed) ? parsed : [parsed]) {
        if (t && typeof t.id === "string" && typeof t.prompt === "string" && typeof t.check === "string") tasks.push(t);
      }
    } catch { /* skip malformed task files */ }
  }
  return tasks;
}

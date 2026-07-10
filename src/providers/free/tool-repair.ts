// Tool-call post-processing for free-tier models — ported from freellmapi-suite lib/tool-args.ts
// (repairToolArguments) and lib/tool-call-rescue.ts (rescueInlineToolCalls). Both are pure. Free models
// mangle tool calls in two recurring ways this fixes:
//   1. double-encoding — nested JSON emitted as a STRING inside an argument (GLM family), which strict
//      clients reject. Schema-gated: only unwrapped when the schema says the param is an array/object.
//   2. inline dialect — a model continuing another model's history emits the tool call as TEXT in a
//      private dialect (Kimi/DeepSeek tokens, Llama <function=> tags, Qwen/Hermes XML, or a bare JSON
//      object naming a tool) instead of a structured call. We detect + re-parse those into tool_use blocks.
import type { ContentBlock, ModelResponse, ToolDef } from "../types.ts";

interface JsonSchemaish {
  type?: string;
  properties?: Record<string, JsonSchemaish>;
}

/** Repair a tool call's `arguments` JSON STRING against its parameter schema. Returns the original string
 *  untouched whenever anything doesn't parse or match — must never corrupt a valid call. */
export function repairToolArguments(args: string, paramSchema?: JsonSchemaish): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }

  let changed = false;

  // Whole-arguments double encoding: `"{\"a\":1}"` parses to a string that is itself JSON of an object.
  if (typeof parsed === "string") {
    try {
      const inner = JSON.parse(parsed);
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
        parsed = inner;
        changed = true;
      } else {
        return args;
      }
    } catch {
      return args;
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return changed ? JSON.stringify(parsed) : args;
  }

  const props = paramSchema?.properties;
  if (props) {
    const obj = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== "string") continue;
      const want = props[key]?.type;
      if (want !== "array" && want !== "object") continue;
      const trimmed = value.trim();
      if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) continue;
      try {
        const inner = JSON.parse(trimmed);
        const isMatch =
          want === "array"
            ? Array.isArray(inner)
            : inner !== null && typeof inner === "object" && !Array.isArray(inner);
        if (isMatch) {
          obj[key] = inner;
          changed = true;
        }
      } catch {
        // Not actually JSON — leave the string alone.
      }
    }
  }

  return changed ? JSON.stringify(parsed) : args;
}

// ── Inline tool-call dialect rescue ───────────────────────────────────────────
export interface RescuedToolCall {
  name: string;
  /** JSON string, exactly like OpenAI's function.arguments. */
  arguments: string;
}

export interface RescueResult {
  detected: boolean;
  calls: RescuedToolCall[] | null;
  cleanText: string;
}

/** Extract one balanced JSON object/array starting at text[from]. String-aware. Null when unbalanced. */
function extractBalancedJson(text: string, from: number): { json: string; end: number } | null {
  const open = text[from];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { json: text.slice(from, i + 1), end: i + 1 };
    }
  }
  return null;
}

const isKnownTool = (name: string, toolNames: Set<string>): boolean => toolNames.size === 0 || toolNames.has(name);

function callFromNamedJson(json: string, toolNames: Set<string>): RescuedToolCall | null {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : undefined;
  if (!name || !isKnownTool(name, toolNames)) return null;
  const rawArgs = o.arguments ?? o.parameters ?? {};
  const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
  try {
    JSON.parse(args);
  } catch {
    return null;
  }
  return { name, arguments: args };
}

/** Dialect 1: Kimi/DeepSeek <|tool_call_begin|> token blocks. */
function parseTokenDialect(
  text: string,
  toolNames: Set<string>,
): { calls: RescuedToolCall[] | null; cleanText: string } {
  const calls: RescuedToolCall[] = [];
  let clean = text.replaceAll("<|tool_calls_section_begin|>", "").replaceAll("<|tool_calls_section_end|>", "");
  const callRe = /<\|tool_call_begin\|>\s*([\s\S]*?)\s*<\|tool_call_argument_begin\|>\s*/g;
  let m: RegExpExecArray | null;
  let parsedAll = true;
  const spans: Array<{ from: number; to: number }> = [];
  while ((m = callRe.exec(clean)) !== null) {
    const idToken = m[1].trim();
    const argStart = m.index + m[0].length;
    const jsonStart = clean.indexOf("{", argStart);
    const extracted = jsonStart === -1 ? null : extractBalancedJson(clean, jsonStart);
    const nameMatch = /^functions\.([A-Za-z0-9_.-]+):\d+$/.exec(idToken);
    const name = nameMatch?.[1];
    let argsOk = false;
    if (extracted && name && isKnownTool(name, toolNames)) {
      try {
        JSON.parse(extracted.json);
        argsOk = true;
      } catch {
        /* fall through */
      }
      if (argsOk) calls.push({ name, arguments: extracted.json });
    }
    if (!argsOk) parsedAll = false;
    const endTag = clean.indexOf("<|tool_call_end|>", extracted?.end ?? argStart);
    spans.push({
      from: m.index,
      to: endTag === -1 ? (extracted?.end ?? argStart) : endTag + "<|tool_call_end|>".length,
    });
  }
  for (const s of [...spans].reverse()) clean = clean.slice(0, s.from) + clean.slice(s.to);
  return { calls: parsedAll && calls.length > 0 ? calls : null, cleanText: clean.trim() };
}

/** Dialect 2: <function=NAME{...}</function>. */
function parseFunctionTagDialect(
  text: string,
  toolNames: Set<string>,
): { calls: RescuedToolCall[] | null; cleanText: string } {
  const calls: RescuedToolCall[] = [];
  let clean = text;
  let parsedAll = true;
  const headRe = /<function=([A-Za-z0-9_.-]+)\s*>?\s*/g;
  let m: RegExpExecArray | null;
  const spans: Array<{ from: number; to: number }> = [];
  while ((m = headRe.exec(text)) !== null) {
    const name = m[1];
    const afterHead = m.index + m[0].length;
    const jsonStart = text[afterHead] === "{" || text[afterHead] === "[" ? afterHead : text.indexOf("{", afterHead);
    const extracted = jsonStart === -1 ? null : extractBalancedJson(text, jsonStart);
    let ok = false;
    if (extracted && isKnownTool(name, toolNames) && extracted.json.startsWith("{")) {
      try {
        JSON.parse(extracted.json);
        ok = true;
      } catch {
        /* fall through */
      }
      if (ok) calls.push({ name, arguments: extracted.json });
    }
    if (!ok) parsedAll = false;
    const closeTag = text.indexOf("</function>", extracted?.end ?? m.index + m[0].length);
    spans.push({
      from: m.index,
      to: closeTag === -1 ? (extracted?.end ?? m.index + m[0].length) : closeTag + "</function>".length,
    });
  }
  for (const s of [...spans].reverse()) clean = clean.slice(0, s.from) + clean.slice(s.to);
  return { calls: parsedAll && calls.length > 0 ? calls : null, cleanText: clean.trim() };
}

/** Dialect 3: <tool_call>{...}</tool_call> XML-JSON blocks. */
function parseXmlDialect(text: string, toolNames: Set<string>): { calls: RescuedToolCall[] | null; cleanText: string } {
  const calls: RescuedToolCall[] = [];
  let parsedAll = true;
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  let clean = text;
  const matches: string[] = [];
  while ((m = re.exec(text)) !== null) matches.push(m[1]);
  for (const inner of matches) {
    const call = callFromNamedJson(inner, toolNames);
    if (call) calls.push(call);
    else parsedAll = false;
  }
  clean = clean.replace(re, "");
  if (/<tool_call>/.test(clean)) {
    parsedAll = false;
    clean = clean.replace(/<tool_call>[\s\S]*$/, "");
  }
  return { calls: parsedAll && calls.length > 0 ? calls : null, cleanText: clean.trim() };
}

/** Rescue inline tool-call dialects out of an assistant text answer. `toolNames` are the request's declared
 *  tools; rescued calls must name one (empty set accepts any — tests only). Detected-but-unparseable is a
 *  DEAD turn (calls === null). */
export function rescueInlineToolCalls(text: string, toolNames: Set<string>): RescueResult {
  if (!text) return { detected: false, calls: null, cleanText: text };

  if (text.includes("<|tool_call_begin|>") || text.includes("<|tool_calls_section_begin|>")) {
    const { calls, cleanText } = parseTokenDialect(text, toolNames);
    return { detected: true, calls, cleanText };
  }
  if (text.includes("<function=")) {
    const { calls, cleanText } = parseFunctionTagDialect(text, toolNames);
    return { detected: true, calls, cleanText };
  }
  if (text.includes("<tool_call>")) {
    const { calls, cleanText } = parseXmlDialect(text, toolNames);
    return { detected: true, calls, cleanText };
  }

  // Dialect 4: the whole answer is one JSON object naming a known tool (bare or ```json-fenced). Strictly
  // schema-gated — an arbitrary JSON answer must pass through untouched.
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    const call = callFromNamedJson(candidate, toolNames);
    if (call) return { detected: true, calls: [call], cleanText: "" };
  }

  return { detected: false, calls: null, cleanText: text };
}

// ── Applied to a ModelResponse ────────────────────────────────────────────────
function safeParse(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Post-process a ModelResponse from a free-tier model: repair double-encoded tool_use inputs (schema-gated)
 *  and, when the model answered a tool request with an inline dialect in TEXT (stop_reason end_turn but the
 *  text parses to a tool call), convert it to tool_use blocks + stop_reason "tool_use". Mutates + returns
 *  `resp`; sets resp.model to the served "platform/modelId". */
export function postProcessResponse(
  resp: ModelResponse,
  servedModel: string,
  tools: ToolDef[] | undefined,
): ModelResponse {
  const schemas = new Map<string, JsonSchemaish>((tools ?? []).map((t) => [t.name, t.input_schema as JsonSchemaish]));

  // 1. Repair double-encoded arguments on any real tool_use blocks.
  for (const block of resp.content) {
    if (block.type === "tool_use") {
      const repaired = repairToolArguments(JSON.stringify(block.input ?? {}), schemas.get(block.name));
      block.input = safeParse(repaired);
    }
  }

  // 2. Inline-dialect rescue: only when the model DIDN'T already emit a tool call, tools were requested,
  //    and the text parses to a known tool. A dead-turn (detected but unparseable) is left as-is so the
  //    caller's failover/step-retry handles it.
  if (resp.stop_reason === "end_turn" && tools?.length) {
    const textBlock = resp.content.find((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text");
    if (textBlock) {
      const names = new Set(tools.map((t) => t.name));
      const rescue = rescueInlineToolCalls(textBlock.text, names);
      if (rescue.detected && rescue.calls && rescue.calls.length > 0) {
        const next: ContentBlock[] = [];
        if (rescue.cleanText) next.push({ type: "text", text: rescue.cleanText });
        rescue.calls.forEach((c, i) => {
          next.push({
            type: "tool_use",
            id: `call_rescued_${i + 1}`,
            name: c.name,
            input: safeParse(repairToolArguments(c.arguments, schemas.get(c.name))),
          });
        });
        resp.content = next;
        resp.stop_reason = "tool_use";
      }
    }
  }

  resp.model = servedModel;
  return resp;
}

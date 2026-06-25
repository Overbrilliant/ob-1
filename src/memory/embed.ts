// Embedding layer for semantic retrieval (Phase 1).
//
// NOTE on sqlite-vec: research R7 recommends SQLite + sqlite-vec, but neither
// `bun:sqlite` (no extension loading) nor `better-sqlite3` (won't dlopen under Bun)
// can load the extension in this runtime. At single-developer scale a brute-force
// cosine index in TypeScript is sub-millisecond, so we ship that (see vector index in
// store.ts) and keep sqlite-vec as a drop-in for a Node runtime. The Embedder is
// pluggable: a zero-dependency local embedder by default, a real API embedder when a
// key is present.

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** word tokens + padded char trigrams (subword robustness: auth ~ authentication). */
function featurize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    const pad = `#${w}#`;
    for (let i = 0; i + 3 <= pad.length; i++) out.push("g:" + pad.slice(i, i + 3));
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalized, so dot == cosine
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Zero-dependency, deterministic, offline. Signed feature hashing over words +
 *  char trigrams. Not a neural embedder — a solid lexical/subword baseline that the
 *  API embedder transparently replaces. */
export class LocalEmbedder implements Embedder {
  readonly name = "local-hash";
  readonly dim: number;
  constructor(dim = 256) { this.dim = dim; }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const tok of featurize(text)) {
      const h = fnv1a(tok);
      const idx = h % this.dim;
      v[idx] += (h & 0x100) ? 1 : -1; // sign hashing reduces collision bias
    }
    return normalize(v);
  }
}

/** OpenAI-compatible embeddings (text-embedding-3-small by default). Used when a key
 *  is configured; results are L2-normalized so cosine == dot. */
export class ApiEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private apiKey: string;
  private model: string;
  private url: string;

  constructor(apiKey: string, model = "text-embedding-3-small", dim = 1536, url = "https://api.openai.com/v1/embeddings") {
    this.apiKey = apiKey;
    this.model = model;
    this.dim = dim;
    this.url = url;
    this.name = `api:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => normalize(Float32Array.from(d.embedding)));
  }
}

/** Pick an embedder from the environment. Default: local (offline). Set OPENAI_API_KEY
 *  (and optionally OB1_EMBED_MODEL) for real semantic embeddings; OB1_EMBED=local forces local. */
export function makeEmbedder(): Embedder {
  const key = process.env.OPENAI_API_KEY;
  if (key && process.env.OB1_EMBED !== "local") {
    return new ApiEmbedder(key, process.env.OB1_EMBED_MODEL ?? "text-embedding-3-small");
  }
  return new LocalEmbedder();
}

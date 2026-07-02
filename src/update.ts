export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((aa[i] ?? 0) > (bb[i] ?? 0)) return 1;
    if ((aa[i] ?? 0) < (bb[i] ?? 0)) return -1;
  }
  return 0;
}

export async function latestNpmVersion(fetchFn: typeof fetch = fetch, timeoutMs = 1200): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn("https://registry.npmjs.org/@overbrilliant%2Fob1/latest", {
      headers: { accept: "application/json" },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({})) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function updateMessage(current: string, latest: string | null): string | null {
  if (!latest || compareVersions(latest, current) <= 0) return null;
  return `New OB-1 version available: ${latest} (you have ${current}). Update with brew upgrade ob1, npm i -g @overbrilliant/ob1, or rerun the installer.`;
}

export function startUpdateCheck(current: string, notify: (message: string) => void): void {
  if (process.env.CI || /^(1|true|on)$/i.test(process.env.OB1_NO_UPDATE_CHECK ?? "")) return;
  void latestNpmVersion().then((latest) => {
    const msg = updateMessage(current, latest);
    if (msg) notify(msg);
  }).catch(() => {});
}

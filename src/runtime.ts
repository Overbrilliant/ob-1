/** Runtime helpers shared by optional native/WASM integrations. */
export function isBunStandaloneExecutable(): boolean {
  try {
    return typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main.includes("$bunfs");
  } catch {
    return false;
  }
}

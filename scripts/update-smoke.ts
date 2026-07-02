import { compareVersions, latestNpmVersion, updateMessage } from "../src/update.ts";

let fail = false;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fail = true; };

check("compareVersions detects newer patch", compareVersions("0.1.4", "0.1.3") > 0);
check("compareVersions treats v-prefix as equal", compareVersions("v0.1.3", "0.1.3") === 0);
check("compareVersions detects older minor", compareVersions("0.1.3", "0.2.0") < 0);
check("updateMessage only emits for newer versions", !!updateMessage("0.1.3", "0.1.4") && updateMessage("0.1.4", "0.1.3") === null);

const fetchOk = (async () => Response.json({ version: "9.9.9" })) as unknown as typeof fetch;
check("latestNpmVersion parses registry JSON", (await latestNpmVersion(fetchOk, 100)) === "9.9.9");
const fetchBad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
check("latestNpmVersion returns null on non-OK", (await latestNpmVersion(fetchBad, 100)) === null);

if (fail) { console.error("\n✗ update smoke FAILED"); process.exit(1); }
console.log("\n✓ update smoke passed");

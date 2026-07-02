// Compile OB-1 to a single self-contained executable (bundles the Bun runtime — no Bun needed to RUN
// it). Usage: bun run scripts/build-bin.ts [outfile] [bun-target]   (default ./ob1, current platform)
//
// Ink lazily imports `react-devtools-core` only under DEV (reconciler.js gates it on
// process.env.DEV === 'true'), but the bundler still pulls `devtools.js` into the graph, which
// statically imports the package — so we stub it to an empty module. The stub is only ever reached
// when DEV is set AND the real package resolves, which never happens in a shipped binary.
//
// NOTE: native extras (tree-sitter repo map, sqlite-vec KNN) load their wasm/native libs from
// node_modules at runtime, so the standalone binary uses OB-1's built-in pure-TS fallbacks for those.
// For the full native experience, install the launcher instead (scripts/install.sh) — it runs through
// Bun from the repo with node_modules intact.
export {}; // make this a module so top-level await is allowed

const versionSync = Bun.spawnSync(["bun", "run", "scripts/generate-version.ts"], { stdout: "pipe", stderr: "pipe" });
if ((versionSync.exitCode ?? 1) !== 0) {
  process.stdout.write(versionSync.stdout);
  process.stderr.write(versionSync.stderr);
  process.exit(versionSync.exitCode ?? 1);
}

const outfile = process.argv[2] ?? "ob1";
const target = process.argv[3] || process.env.OB1_BUILD_TARGET || undefined;

const out = await Bun.build({
  entrypoints: ["./src/index.ts"],
  target: "bun",
  // @ts-expect-error — `compile` is supported by Bun.build (produces a standalone executable)
  compile: target ? { outfile, target } : { outfile },
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "rdt-stub" }));
        build.onLoad({ filter: /.*/, namespace: "rdt-stub" }, () => ({ contents: "export default {};", loader: "js" }));
      },
    },
  ],
});

if (!out.success) {
  console.error("✗ build failed:");
  for (const log of out.logs) console.error("  " + log.message);
  process.exit(1);
}
console.log(`✓ built ${outfile}${target ? ` (${target})` : ""}`);

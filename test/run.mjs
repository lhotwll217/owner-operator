// Tier runner — discover and run every root-src test of one tier, fail-fast.
//   node test/run.mjs <unit|integration|e2e>
// Tier is the filename suffix (see docs/testing.md): unit = *.test.ts EXCLUDING the
// integration/e2e tiers; the others match their own suffix. Each file is a tsx script that
// throws (→ nonzero exit) on failure, so we stop at the first that fails. Drop a new
// *.integration.test.ts anywhere under src/ or test/ and it joins the tier automatically —
// no script to edit. Live tests are explicitly excluded; smoke files do not use *.test.ts.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TIERS = { unit: null, integration: ".integration.test.ts", e2e: ".e2e.test.ts" };
const tier = process.argv[2];
if (!(tier in TIERS)) {
  console.error(`usage: node test/run.mjs <${Object.keys(TIERS).join("|")}>`);
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    if (e.name === "node_modules") return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const matches = (f) =>
  tier === "unit"
    ? f.endsWith(".test.ts")
      && !f.endsWith(".integration.test.ts")
      && !f.endsWith(".e2e.test.ts")
      && !f.endsWith(".live.test.ts")
    : f.endsWith(TIERS[tier]);

const files = [join(root, "src"), join(root, "test")].flatMap(walk).filter(matches).sort();
if (files.length === 0) { console.log(`no ${tier} tests`); process.exit(0); }

for (const file of files) {
  console.log(`\n▶ ${tier}: ${relative(root, file)}`);
  const r = spawnSync(process.execPath, ["--import", "tsx", file], { stdio: "inherit", cwd: root });
  if (r.status !== 0) {
    console.error(`✗ ${relative(root, file)} failed`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\n✓ ${tier}: ${files.length} file(s) passed`);

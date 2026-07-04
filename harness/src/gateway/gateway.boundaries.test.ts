// Guard for the gateway's dependency direction (#14): the gateway is the innermost
// component after core — model-free, agent-free. Runtime modules here must never import
// pi (`@earendil-works/*`) or anything from src/agent, src/tui, or src/cli. Dev scripts
// (*.test.ts, *.smoke.ts) are exempt — they may drive outer layers to exercise this one.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = readdirSync(here).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".smoke.ts"),
);
assert.ok(runtime.length >= 5, `gateway runtime modules found (${runtime.length})`);

const FORBIDDEN = [
  { re: /from\s+["']@earendil-works\//, why: "pi import — the gateway is model-free" },
  { re: /from\s+["']\.\.\/(agent|tui|cli)\//, why: "outward import — agent/surfaces are clients of the gateway, never the reverse" },
];

for (const file of runtime) {
  const src = readFileSync(join(here, file), "utf8");
  for (const { re, why } of FORBIDDEN) {
    assert.ok(!re.test(src), `${file}: ${why}`);
  }
}

console.log(`ok — gateway boundary: ${runtime.length} runtime modules import no pi, no agent/tui/cli`);

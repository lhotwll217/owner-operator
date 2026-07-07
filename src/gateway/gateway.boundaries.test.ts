// Guard for the gateway's dependency direction (#14): the gateway is a top-level component,
// model-free and agent-free. Runtime modules here must never import pi, agent, CLI, or UI
// surfaces. Dev scripts (*.test.ts, *.smoke.ts) are exempt — they may drive the gateway.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = readdirSync(here, { recursive: true, withFileTypes: false })
  .map((f) => relative(here, join(here, String(f))))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".smoke.ts"));
assert.ok(runtime.length >= 5, `gateway runtime modules found (${runtime.length})`);

const FORBIDDEN = [
  { re: /from\s+["']@earendil-works\//, why: "pi import — the gateway is model-free" },
  { re: /from\s+["'][^"']*\.\.\/agent\//, why: "agent import — gateway must stay model-free" },
  { re: /from\s+["'][^"']*\.\.\/cli\//, why: "CLI import — gateway must stay surface-free" },
  { re: /from\s+["']\.\.\/\.\.\//, why: "upward source import — use core or a gateway-local seam" },
];

for (const file of runtime) {
  const src = readFileSync(join(here, file), "utf8");
  for (const { re, why } of FORBIDDEN) {
    assert.ok(!re.test(src), `${file}: ${why}`);
  }
}

console.log(`ok — gateway boundary: ${runtime.length} runtime modules import no pi, agent, or CLI`);

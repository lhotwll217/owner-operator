// Guard for the gateway's dependency direction (#14): the gateway is its own package,
// model-free and agent-free. Runtime modules here must never import pi, harness, or UI
// surfaces. Dev scripts (*.test.ts, *.smoke.ts) are exempt — they may drive the package.
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
  { re: /from\s+["']@owner-operator\/harness/, why: "harness import — harness is a gateway client" },
  { re: /from\s+["'][^"']*harness\//, why: "harness path import — package boundary bypass" },
  { re: /from\s+["']\.\.\/\.\.\//, why: "upward source import — use core or a gateway-local seam" },
];

for (const file of runtime) {
  const src = readFileSync(join(here, file), "utf8");
  for (const { re, why } of FORBIDDEN) {
    assert.ok(!re.test(src), `${file}: ${why}`);
  }
}

console.log(`ok — gateway boundary: ${runtime.length} runtime modules import no pi and no harness`);

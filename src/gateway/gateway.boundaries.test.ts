// Public architecture guard: the gateway is transport only. Runtime modules here may
// translate HTTP/SSE into typed state calls, but may not own persistence, polling,
// scheduling, model calls, or process execution.
import assert from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = readdirSync(here, { recursive: true, withFileTypes: false })
  .map((f) => relative(here, join(here, String(f))))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".smoke.ts"));
assert.ok(runtime.length >= 5, `gateway runtime modules found (${runtime.length})`);

const FORBIDDEN = [
  { re: /from\s+["']@earendil-works\//, why: "pi import — the gateway is model-free" },
  { re: /from\s+["']node:(?:child_process|sqlite|fs\/promises)["']/, why: "runtime/process ownership belongs outside transport" },
  { re: /from\s+["'][^"']*\.\.\/agent\//, why: "agent import — gateway must stay model-free" },
  { re: /from\s+["'][^"']*\.\.\/cli\//, why: "CLI import — gateway must stay surface-free" },
  { re: /from\s+["'][^"']*\.\.\/session-monitor\//, why: "session monitoring belongs to the daemon composition root" },
  { re: /from\s+["'][^"']*\.\.\/scheduler\//, why: "scheduler execution belongs to the daemon composition root" },
];

for (const file of runtime) {
  const src = readFileSync(join(here, file), "utf8");
  for (const { re, why } of FORBIDDEN) {
    assert.ok(!re.test(src), `${file}: ${why}`);
  }
}

const appRuntimeInSkills = [join(here, "..", "..", ".agents", "skills")]
  .flatMap((root) => {
    try {
      return readdirSync(root, { recursive: true, withFileTypes: false })
        .map(String)
        .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file));
    } catch {
      return [];
    }
  });
assert.deepEqual(appRuntimeInSkills, [], "agent skill directories contain instructions only, never application runtime");

const projectRoot = join(here, "..", "..");
const architectureRuntime = [join(projectRoot, "src"), join(projectRoot, "packages")]
  .flatMap((root) => readdirSync(root, { recursive: true, withFileTypes: false })
    .map((file) => join(root, String(file)))
    .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !file.endsWith(".test.ts")));
const retiredArchitecture = /\b(?:StatusSnapshot|in_snapshot|OO_DAEMON)\b|status\.json|threads\.db/;
for (const file of architectureRuntime) {
  const source = readFileSync(file, "utf8");
  const path = relative(projectRoot, file);
  assert.ok(!retiredArchitecture.test(source), `${path}: retired snapshot/fallback architecture`);
  assert.ok(!/(?:\.agents|\.claude)\/skills/.test(source), `${path}: application runtime must not load code from a skills directory`);
  if (!path.startsWith("src/state/")) {
    assert.ok(!/from\s+["']node:sqlite["']/.test(source), `${path}: SQLite access belongs to src/state`);
  }
}

const architecture = readFileSync(join(projectRoot, "docs", "architecture.md"), "utf8");
const documentedPaths = [...architecture.matchAll(/`((?:src|packages\/core)(?:\/[^`]+)?)`/g)]
  .map((match) => match[1]);
for (const documentedPath of documentedPaths) {
  assert.ok(existsSync(join(projectRoot, documentedPath)), `docs/architecture.md names missing path: ${documentedPath}`);
}

console.log(`ok — gateway transport boundary and skill/runtime boundary hold`);

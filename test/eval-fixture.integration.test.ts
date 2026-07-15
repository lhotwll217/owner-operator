// Integration: the eval seed is structurally isolated from its answer key and every DB
// locator has a transcript path. These are harness invariants, not model-scored behavior.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalSandboxPath } from "../eval/sandbox.mjs";

const repoRoot = process.cwd();
const testRoot = mkdtempSync(join(tmpdir(), "oo-eval-fixture-test-"));
const requestedSandbox = evalSandboxPath(`fixture-test-${process.pid}-${Date.now()}`);
assert.notEqual(
  requestedSandbox,
  evalSandboxPath(`fixture-test-other-${process.pid}-${Date.now()}`),
  "each run id gets an independent fixture home",
);

const sentinel = join(testRoot, "keep.txt");
writeFileSync(sentinel, "must survive\n");
const refused = spawnSync("npx", ["tsx", "eval/seed/build-fixture-home.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, OO_EVAL_SANDBOX: testRoot },
});
assert.notEqual(refused.status, 0, "the seeder rejects an arbitrary deletion target");
assert.match(refused.stderr, /refusing to replace eval sandbox outside/i);
assert.equal(existsSync(sentinel), true, "a rejected path is never deleted");

const seed = spawnSync("npx", ["tsx", "eval/seed/build-fixture-home.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, OO_EVAL_SANDBOX: requestedSandbox },
});
assert.equal(seed.status, 0, seed.stderr);
const sandbox = seed.stdout.trim().split("\n").at(-1);
assert.ok(sandbox, "seed prints its sandbox path");
assert.equal(sandbox, requestedSandbox, "fixture tests use their requested isolated sandbox");

try {
  const db = new DatabaseSync(join(sandbox, "home", "state.db"), { readOnly: true });
  const counts = db.prepare(`
    SELECT count(*) AS total,
           sum(CASE WHEN transcript_path IS NOT NULL AND transcript_path != '' THEN 1 ELSE 0 END) AS with_paths
    FROM threads
  `).get() as { total: number; with_paths: number };
  db.close();
  assert.ok(counts.total > 0, "fixture DB contains threads");
  assert.equal(counts.with_paths, counts.total, "every fixture thread has a transcript path");

  const ownerOperatorSessions = readdirSync(join(sandbox, "home", "sessions"))
    .filter((file) => file.endsWith(".jsonl"));
  assert.equal(ownerOperatorSessions.length, 4, "fixture includes in-window evidence plus an older scope decoy");
  assert.equal(counts.total, 10, "saved Owner Operator sessions stay out of the coding-thread index");

  const blacklist = JSON.parse(readFileSync(join(sandbox, "home", "blacklist.json"), "utf8")) as { paths?: string[] };
  assert.ok(blacklist.paths?.includes(join(repoRoot, "eval")), "eval subjects cannot read the answer key");
  assert.ok(!blacklist.paths?.includes(repoRoot), "the shipped session-search skill remains readable");
  process.stdout.write(`ok — eval fixture: ${counts.total} transcript paths; answer key blacklisted\n`);
} finally {
  rmSync(requestedSandbox, { recursive: true, force: true });
  rmSync(testRoot, { recursive: true, force: true });
}

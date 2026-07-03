// e2e: `oo one-shot` argument contract through the real launcher. Both failure paths exit 2
// BEFORE any model session is built (so they're fast and need no backend). The prompted path
// needs a live model, so it isn't exercised here.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const ooBin = join(repoRoot, "harness", "oo");
const ooHome = mkdtempSync(join(tmpdir(), "oo-one-shot-e2e-")); // empty OO_HOME: no real agent sessions
const opts = { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: { ...process.env, OO_HOME: ooHome } } as const;

try {
  const noPrompt = spawnSync(ooBin, ["one-shot"], opts);
  assert.equal(noPrompt.status, 2, `no-prompt exits 2 (got ${noPrompt.status}; stderr: ${noPrompt.stderr})`);
  assert.match(noPrompt.stderr, /usage: oo one-shot/, "prints usage on stderr");
  assert.equal(noPrompt.stdout, "", "nothing on stdout — it's the answer channel");

  const badSession = spawnSync(ooBin, ["one-shot", "--session", "nope123", "hi"], opts);
  assert.equal(badSession.status, 2, `unknown --session exits 2 (got ${badSession.status}; stderr: ${badSession.stderr})`);
  assert.match(badSession.stderr, /no agent session matching "nope123"/, "names the unmatched session ref");
  assert.equal(badSession.stdout, "", "nothing on stdout for a bad session ref");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — one-shot e2e: missing prompt and unknown --session → exit 2, stdout clean\n");

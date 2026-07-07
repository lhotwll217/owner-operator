// e2e: regular `oo` owns the headless/resume contract. Failure paths exit before any
// model session is built, so this stays hermetic and fast.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";

const ooBin = join(repoRoot, "oo");
const ooHome = mkdtempSync(join(tmpdir(), "oo-cli-e2e-"));
const opts = { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: { ...process.env, OO_HOME: ooHome } } as const;

try {
  const help = spawnSync(ooBin, ["--help"], opts);
  assert.equal(help.status, 0, `oo --help exits 0 (got ${help.status}; stderr: ${help.stderr})`);
  assert.match(help.stdout, /oo --continue "and then\?"/, "top-level help advertises --continue");
  assert.match(help.stdout, /oo --session <id> "more"/, "top-level help advertises --session");
  assert.match(help.stdout, /oo --session-state/, "top-level help advertises --session-state");
  assert.doesNotMatch(help.stdout, /oo --json/, "top-level help does not advertise old --json name");
  assert.equal(help.stderr, "", "top-level help is clean: no agent/runtime warnings");

  const oldJson = spawnSync(ooBin, ["--json"], opts);
  assert.equal(oldJson.status, 2, `old --json exits 2 (got ${oldJson.status}; stderr: ${oldJson.stderr})`);
  assert.match(oldJson.stderr, /renamed to --session-state/, "old --json points to the explicit state flag");
  assert.equal(oldJson.stdout, "", "old --json does not build a model session");

  for (const spelling of [["one", "shot"].join("-"), ["one", "shot"].join("")]) {
    const removed = spawnSync(ooBin, [spelling, "what changed?"], opts);
    assert.equal(removed.status, 2, `${spelling} exits 2 (got ${removed.status}; stderr: ${removed.stderr})`);
    assert.match(removed.stderr, /has been removed/, `${spelling} is a removal error`);
    assert.equal(removed.stdout, "", `${spelling} does not build a model session`);
  }

  const trailingSession = spawnSync(ooBin, ["hi", "--session"], opts);
  assert.equal(trailingSession.status, 2, `trailing --session exits 2 (got ${trailingSession.status}; stderr: ${trailingSession.stderr})`);
  assert.match(trailingSession.stderr, /--session needs an id or path/, "trailing --session names the missing value");
  assert.equal(trailingSession.stdout, "", "trailing --session exits before stdout/model work");

  const mixedInteractive = spawnSync(ooBin, ["--continue", "-i"], opts);
  assert.equal(mixedInteractive.status, 2, `mixed -i exits 2 (got ${mixedInteractive.status}; stderr: ${mixedInteractive.stderr})`);
  assert.match(mixedInteractive.stderr, /only valid by itself/, "-i with resume is rejected before agent setup");
  assert.equal(mixedInteractive.stdout, "", "mixed -i exits before stdout/model work");

  const missingSession = spawnSync(ooBin, ["--session", "nope123", "hi"], opts);
  assert.equal(missingSession.status, 2, `unknown --session exits 2 (got ${missingSession.status}; stderr: ${missingSession.stderr})`);
  assert.match(missingSession.stderr, /no oo session matching "nope123"/, "names the unmatched session ref");
  assert.equal(missingSession.stdout, "", "nothing on stdout for a bad session ref");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — regular oo help/session-state/resume contract; removed flags and bad resume args exit 2\n");

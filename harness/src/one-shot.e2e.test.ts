// e2e: `oo one-shot` argument contract through the real launcher. No prompt → usage on
// stderr + exit 2, BEFORE any model session is built (so it's fast and needs no backend).
// The prompted path needs a live model, so it isn't exercised here — the rpc e2e already
// covers building the neutral session when one is configured.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const ooBin = join(repoRoot, "harness", "oo");

const r = spawnSync(ooBin, ["one-shot"], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
assert.equal(r.status, 2, `no-prompt exits 2 (got ${r.status}; stderr: ${r.stderr})`);
assert.match(r.stderr, /usage: oo one-shot/, "prints usage on stderr");
assert.equal(r.stdout, "", "nothing on stdout — it's the answer channel");

process.stdout.write("ok — one-shot e2e: missing prompt → usage + exit 2, stdout clean\n");

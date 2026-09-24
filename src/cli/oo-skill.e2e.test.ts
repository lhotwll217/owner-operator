// e2e: `oo skill install|status|uninstall` and `oo doctor` against a disposable HOME. Model-free
// and daemon-free: linking a skill touches only the harness folders.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";

const root = mkdtempSync(join(tmpdir(), "oo-skill-e2e-"));
const home = join(root, "home");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, OO_HOME: join(root, "oo-home") };
delete env.CLAUDE_CONFIG_DIR;
delete env.CODEX_HOME;
const oo = (args: string[]) => spawnSync(join(repoRoot, "oo"), args, { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000 });

try {
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  const install = oo(["skill", "install", "--json"]);
  assert.equal(install.status, 0, install.stderr);
  assert.deepEqual((JSON.parse(install.stdout) as Array<{ label: string; action: string }>).map(({ label, action }) => [label, action]), [
    ["agents", "linked"], ["claude", "linked"], ["codex", "skipped"], ["cursor", "skipped"],
  ]);
  const linked = join(home, ".claude", "skills", "owner-operator");
  assert.equal(realpathSync(linked), realpathSync(join(repoRoot, "skills", "owner-operator")), "the harness link resolves into this checkout");
  assert.match(readFileSync(join(linked, "SKILL.md"), "utf8"), /^name: owner-operator$/m);

  const status = oo(["skill", "status"]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /^linked\s+claude\s+\S+owner-operator -> \S+\.agents\/skills\/owner-operator$/m);
  assert.match(status.stdout, /^no-folder\s+codex/m);

  const doctor = oo(["doctor"]);
  assert.match(doctor.stdout, /Outside-agent skill \(oo skill status\):\n {2}agents: linked .*\n {2}claude: linked /, "doctor lists the skill links");

  const uninstall = oo(["skill", "uninstall"]);
  assert.equal(uninstall.status, 0);
  assert.match(uninstall.stdout, /^removed\s+claude/m);
  assert.match(oo(["skill", "status"]).stdout, /^absent\s+claude/m);
  assert.match(oo(["skill", "--help"]).stdout, /install\s.*\n\s+uninstall\s.*\n\s+status\s/, "noun help lists the verbs");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — oo skill: install links this checkout, status and doctor report links, uninstall removes them\n");

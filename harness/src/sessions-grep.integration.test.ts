// Integration: the real sessions-grep script enforces the privacy blacklist. A match inside a
// blacklisted tree is never returned (both layers: project-dir slug, and post-parse cwd); a match
// in a normal repo is. Needs ripgrep, like the skill — skips cleanly if it's absent.
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (spawnSync("rg", ["--version"], { stdio: "ignore" }).status !== 0) {
  process.stdout.write("skip — ripgrep (rg) not installed; sessions-grep blacklist test needs it\n");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const GREP = join(here, "..", "..", ".agents/skills/sessions-grep/sessions-grep.mjs");

const home = mkdtempSync(join(tmpdir(), "oo-grep-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-grep-oohome-"));
try {
  const NEEDLE = "ZZUNIQUENEEDLEZZ";
  const claudeMsg = (id: string, cwd: string, text: string) =>
    JSON.stringify({ type: "user", sessionId: id, cwd, timestamp: "2026-06-30T10:00:00.000Z", message: { content: text } }) + "\n";
  const slugOf = (cwd: string) => cwd.replace(/[^A-Za-z0-9-]/g, "-");
  const writeSession = (dir: string, id: string, cwd: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), claudeMsg(id, cwd, `here is the ${NEEDLE} you want`));
  };

  const privateRoot = join(home, "Documents", "Private");
  writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateRoot], repos: [] }));

  // Visible: normal repo, project dir slugged from its cwd.
  const okId = "okokokok-1111-2222-3333-444444444444";
  const okCwd = join(home, "dev", "normal-repo");
  writeSession(join(home, ".claude", "projects", slugOf(okCwd)), okId, okCwd);

  // Blocked by layer 1: project-dir slug is under the blacklisted tree.
  const slugId = "slugslug-1111-2222-3333-444444444444";
  const slugCwd = join(privateRoot, "Career");
  writeSession(join(home, ".claude", "projects", slugOf(slugCwd)), slugId, slugCwd);

  // Blocked by layer 2: dir name is NOT slugged to the tree, but the record's cwd is inside it.
  const cwdId = "cwdcwdcw-1111-2222-3333-444444444444";
  const cwdCwd = join(privateRoot, "Jobs", "acme");
  writeSession(join(home, ".claude", "projects", "misc"), cwdId, cwdCwd);

  const out = execFileSync(process.execPath, [GREP, "--query", NEEDLE, "--source", "claude", "--json"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  const ids = JSON.parse(out).matches.map((m: { id: string }) => m.id);

  assert.ok(ids.includes(okId), "normal-repo match is returned");
  assert.ok(!ids.includes(slugId), "blacklisted project-dir slug (layer 1) is excluded");
  assert.ok(!ids.includes(cwdId), "blacklisted cwd tree (layer 2) is excluded");

  process.stdout.write("ok — sessions-grep blacklist: slug layer + cwd layer both exclude private trees\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

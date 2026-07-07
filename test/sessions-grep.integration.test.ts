// Integration: the real sessions-grep script enforces the privacy blacklist. A match inside a
// blacklisted tree is never returned (both layers: project-dir slug, and post-parse cwd); a match
// in a normal repo is. Also: oo's own threads live under <OO_HOME>/sessions and are found
// by pointing the vendored primitive at that directory as typed pi sessions — never via the
// wrapper's default `all` search. Needs ripgrep, like the skill — skips cleanly if absent.
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
const GREP = join(here, "..", ".agents/skills/sessions-grep/sessions-grep.mjs");
const VENDOR_GREP = join(here, "..", ".agents/skills/sessions-grep/vendor/session-grep.mjs");

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

  // oo's own threads (pi session format) in the separate Owner Operator dir.
  const ownerOperatorDir = join(ooHome, "sessions");
  mkdirSync(ownerOperatorDir, { recursive: true });
  const writeOwnerOperatorSession = (id: string) =>
    writeFileSync(
      join(ownerOperatorDir, `${id}.jsonl`),
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-30T10:00:00.000Z", cwd: join(home, "dev", "normal-repo") }) + "\n" +
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-06-30T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: `I already reported the ${NEEDLE} thread` }] } }) + "\n",
    );
  const ownerOperatorId = "owneropr-1111-2222-3333-444444444444";
  const otherOwnerOperatorId = "ooother-1111-2222-3333-444444444444";
  writeOwnerOperatorSession(ownerOperatorId);
  writeOwnerOperatorSession(otherOwnerOperatorId);

  const run = (...extra: string[]): { id: string; source?: string }[] => {
    const out = execFileSync(process.execPath, [GREP, "--query", NEEDLE, "--json", ...extra], {
      env: { ...process.env, HOME: home, OO_HOME: ooHome },
      encoding: "utf8",
    });
    return JSON.parse(out).matches;
  };
  const ownerOperatorSources = join(ooHome, "owner-operator-sources.json");
  writeFileSync(ownerOperatorSources, JSON.stringify([
    { type: "claude", root: join(home, ".claude", "projects") },
    { type: "pi", root: ownerOperatorDir },
  ]));
  const runOwnerOperator = (): { id: string; source?: string }[] => {
    const out = execFileSync(process.execPath, [VENDOR_GREP, "--query", NEEDLE, "--json", "--sources-file", ownerOperatorSources, "--target-root", ownerOperatorDir], {
      env: { ...process.env, HOME: home, OO_HOME: ooHome },
      encoding: "utf8",
    });
    return JSON.parse(out).matches;
  };
  const idsOf = (ms: { id: string }[]) => ms.map((m) => m.id);

  const ids = idsOf(run("--target-type", "claude"));
  assert.ok(ids.includes(okId), "normal-repo match is returned");
  assert.ok(!ids.includes(slugId), "blacklisted project-dir slug (layer 1) is excluded");
  assert.ok(!ids.includes(cwdId), "blacklisted cwd tree (layer 2) is excluded");

  assert.ok(!idsOf(run()).includes(ownerOperatorId), "Owner Operator sessions stay out of the wrapper's default `all` search");
  const ownerOperatorMatches = runOwnerOperator();
  assert.deepEqual(
    idsOf(ownerOperatorMatches).sort(),
    [ownerOperatorId, otherOwnerOperatorId].sort(),
    "typed source file plus target-root points the primitive at Owner Operator sessions",
  );
  assert.ok(ownerOperatorMatches.every((m) => m.source === "pi"), "Owner Operator sessions are just pi-format sessions to the primitive");
  process.stdout.write("ok — sessions-grep: blacklist layers hold; Owner Operator sessions use typed sources + target-root\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

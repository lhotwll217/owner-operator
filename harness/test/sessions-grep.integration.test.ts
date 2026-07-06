// Integration: the real sessions-grep script enforces the privacy blacklist. A match inside a
// blacklisted tree is never returned (both layers: project-dir slug, and post-parse cwd); a match
// in a normal repo is. Also: oo's own threads (`--source self`, pi format + oo-provenance labels,
// under <OO_HOME>/sessions) are found only when targeted explicitly — never part of `all` — and
// `--surface` narrows to one surface. Needs ripgrep, like the skill — skips cleanly if absent.
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

  // oo's own threads (pi session format + oo-provenance labels) in the separate self dir:
  // one from the one-shot surface, one from the TUI.
  const selfDir = join(ooHome, "sessions");
  mkdirSync(selfDir, { recursive: true });
  const provenance = (surface: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "custom", id: "p1", parentId: null, timestamp: "2026-06-30T10:00:00.500Z", customType: "oo-provenance", data: { surface, origin: surface === "tui" ? "owner" : "agent", callerCwd: "/w", callerRepo: "acme-app", ppid: 1, ...extra } }) + "\n";
  const writeSelf = (id: string, surface: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(selfDir, `${id}.jsonl`),
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-30T10:00:00.000Z", cwd: join(home, "dev", "normal-repo") }) + "\n" +
        provenance(surface, extra) +
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-06-30T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: `I already reported the ${NEEDLE} thread` }] } }) + "\n",
    );
  const selfId = "selfself-1111-2222-3333-444444444444";
  const tuiId = "tuituitu-1111-2222-3333-444444444444";
  writeSelf(selfId, "one-shot", { fromSession: "caller-abc" });
  writeSelf(tuiId, "tui");

  const run = (...extra: string[]): { id: string; surface?: string; repo?: string; provenance?: { fromSession?: string } }[] => {
    const out = execFileSync(process.execPath, [GREP, "--query", NEEDLE, "--json", ...extra], {
      env: { ...process.env, HOME: home, OO_HOME: ooHome },
      encoding: "utf8",
    });
    return JSON.parse(out).matches;
  };
  const idsOf = (ms: { id: string }[]) => ms.map((m) => m.id);

  const ids = idsOf(run("--source", "claude"));
  assert.ok(ids.includes(okId), "normal-repo match is returned");
  assert.ok(!ids.includes(slugId), "blacklisted project-dir slug (layer 1) is excluded");
  assert.ok(!ids.includes(cwdId), "blacklisted cwd tree (layer 2) is excluded");

  assert.ok(!idsOf(run()).includes(selfId), "self threads stay out of the default `all` search");
  const selfMatches = run("--source", "self");
  assert.deepEqual(idsOf(selfMatches).sort(), [selfId, tuiId].sort(), "self finds every oo surface, ONLY from the self dir");
  const oneShotHit = selfMatches.find((m) => m.id === selfId);
  assert.equal(oneShotHit?.surface, "one-shot", "hit is labeled with its surface");
  assert.equal(oneShotHit?.repo, "acme-app", "hit is labeled with the caller repo");
  assert.equal(oneShotHit?.provenance?.fromSession, "caller-abc", "audit trail: calling session id on the hit");
  assert.deepEqual(idsOf(run("--source", "self", "--surface", "tui")), [tuiId], "--surface narrows to one surface");

  process.stdout.write("ok — sessions-grep: blacklist layers hold; self source separate, labeled, surface-filterable\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

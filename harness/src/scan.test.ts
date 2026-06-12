// Integration test of the scan skill — the REAL get-active-threads script against fake
// session files (Claude + Cursor), a real throwaway git repo, and a fake status store.
// Proves: the canonical-resolver contract at the skill surface (done excluded by default,
// --include-done audits, drill-in answers, newer message wakes), the Cursor finder (slug →
// cwd reconstruction), origin-app detection (Superset/Cursor), and the git ± delta.
//   npm run test:scan      (from harness/)

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCAN = join(here, "..", "..", ".agents/skills/get-active-threads/get-active-threads.mjs");

const home = mkdtempSync(join(tmpdir(), "oo-scan-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-scan-store-"));

const sid = "11111111-2222-3333-4444-555555555555";
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
// Claude session, spawned in a (fake) Superset worktree → App resolves to "Superset App".
const claudeCwd = join(home, ".superset", "worktrees", "sb", "demo-repo");
const sessionFile = join(home, ".claude", "projects", "demo", `${sid}.jsonl`);
const msg = (type: "user" | "assistant", content: string, ts: string) =>
  JSON.stringify({ type, sessionId: sid, cwd: claudeCwd, timestamp: ts, message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) } }) + "\n";

mkdirSync(dirname(sessionFile), { recursive: true });
writeFileSync(
  sessionFile,
  msg("user", "ship the resolver fix", at(30)) +
  msg("assistant", "On it — wiring the resolver.", at(25)) +
  msg("user", "looks good, add tests too", at(20)) +
  msg("assistant", "Tests added; resolver join is wired.", at(10)),
);

// Cursor session in a REAL git repo whose path contains dashes (the slug-reconstruction
// edge) and a +3 −1 working-tree delta vs HEAD.
const repoDir = join(home, "dev", "demo-app-x");
mkdirSync(repoDir, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", repoDir, ...a], {
  env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  stdio: ["ignore", "pipe", "pipe"],
});
git("init", "-q");
writeFileSync(join(repoDir, "f.txt"), "a\nb\nc\n");
git("add", ".");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
writeFileSync(join(repoDir, "f.txt"), "a\nB\nc\nd\ne\n"); // change 1 line, add 2 → +3 −1

const cid = "99999999-8888-7777-6666-555555555555";
const slug = repoDir.slice(1).split("/").join("-"); // Cursor's cwd → dir-name slugging
const cursorFile = join(home, ".cursor", "projects", slug, "agent-transcripts", cid, `${cid}.jsonl`);
mkdirSync(dirname(cursorFile), { recursive: true });
writeFileSync(
  cursorFile,
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>tighten the retry loop</user_query>" }] } }) + "\n" +
  JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Retry loop tightened; tests pass." }] } }) + "\n",
);

interface ScanThread {
  id: string; state: string; lastMessageAt: string; repo: string; ui: string;
  topic: string; diffAdded?: number; diffDeleted?: number;
  firstMessages: unknown[]; recentMessages: unknown[]; omittedMessageCount: number;
}
const run = (...extra: string[]): { count: number; threads: ScanThread[] } =>
  JSON.parse(execFileSync("node", [SCAN, "--since", "7d", "--json", ...extra], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  }));
const byId = (res: { threads: ScanThread[] }, id: string): ScanThread | undefined =>
  res.threads.find((t) => t.id === id);

try {
  // No owner state yet → both candidates pass, resolved from scan facts alone.
  const fresh = run();
  assert.equal(fresh.count, 2, "scan finds the Claude and Cursor sessions");
  const claude = byId(fresh, sid)!;
  assert.equal(claude.state, "needs-you", "assistant yielded → needs-you");
  assert.equal(claude.ui, "Superset App", "worktree host wins app detection");
  assert.equal(claude.diffAdded, undefined, "no repo at the claude cwd → no delta");

  // The Cursor finder: slug → real cwd (dashes inside the leaf), origin app, git delta.
  const cursor = byId(fresh, cid)!;
  assert.equal(cursor.ui, "Cursor");
  assert.equal(cursor.repo, "demo-app-x", "dash-slug reconstructed against the real filesystem");
  assert.equal(cursor.state, "needs-you", "assistant yielded (no trailing tool_use) → needs-you");
  assert.ok(cursor.topic.includes("tighten the retry loop") && !cursor.topic.includes("<user_query>"), "topic clean of wrapper tags");
  assert.deepEqual([cursor.diffAdded, cursor.diffDeleted], [3, 1], "working-tree delta vs HEAD");

  // --sample 0 is the poller's metadata-only mode: NO message bodies may leak through
  // (slice(-0) used to dump the entire tail).
  const meta = byId(run("--sample", "0"), sid)!;
  assert.deepEqual(
    [meta.firstMessages, meta.recentMessages, meta.omittedMessageCount],
    [[], [], 4],
    "--sample 0 carries metadata only",
  );

  // Operator marks the claude thread done (status.json is the store the resolver joins).
  writeFileSync(join(ooHome, "status.json"), JSON.stringify({
    polledAt: at(5),
    threads: [{ id: sid, state: "done", lastMessageAt: claude.lastMessageAt }],
  }));

  const afterDone = run();
  assert.deepEqual([afterDone.count, byId(afterDone, sid)], [1, undefined], "done thread excluded by default; cursor unaffected");
  const audit = run("--include-done");
  assert.deepEqual([audit.count, byId(audit, sid)?.state], [2, "done"], "--include-done audits it, resolved done");
  const drill = run("--thread", sid);
  assert.deepEqual([drill.count, drill.threads[0].state], [1, "done"], "--thread drill-in always answers");

  // A newer message lands → the same scan wakes the thread (no owner action needed).
  appendFileSync(sessionFile, msg("assistant", "One more thing came up — see the failing CI run.", at(1)));
  const woken = run();
  assert.deepEqual([woken.count, byId(woken, sid)?.state], [2, "needs-you"], "newer message wakes a done thread");

  // ---- privacy blacklist: ABSOLUTE — both layers, no flag bypasses --------------------
  const privateRoot = join(home, "Documents", "Personal");
  writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateRoot], repos: ["Personal"] }));
  const privMsg = (id: string, cwd: string, type: "user" | "assistant", content: string, ts: string) =>
    JSON.stringify({ type, sessionId: id, cwd, timestamp: ts, message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) } }) + "\n";
  // Layer 1: project dir named with the cwd slug → the file is skipped UNREAD.
  const slugId = "aaaaaaaa-1111-2222-3333-444444444444";
  const slugCwd = join(privateRoot, "Career");
  const slugDir = join(home, ".claude", "projects", slugCwd.replace(/[^A-Za-z0-9-]/g, "-"));
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, `${slugId}.jsonl`),
    privMsg(slugId, slugCwd, "user", "private thing", at(8)) +
    privMsg(slugId, slugCwd, "assistant", "noted", at(7)) +
    privMsg(slugId, slugCwd, "user", "more private follow-up", at(6)));
  // Layer 2: unslugged dir (worktree-style) — caught post-parse by the records' cwd.
  const deepId = "bbbbbbbb-1111-2222-3333-444444444444";
  const deepCwd = join(privateRoot, "Career", "Jobs", "acme");
  mkdirSync(join(home, ".claude", "projects", "misc"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "misc", `${deepId}.jsonl`),
    privMsg(deepId, deepCwd, "user", "private lower-level thing", at(8)) +
    privMsg(deepId, deepCwd, "assistant", "noted", at(7)) +
    privMsg(deepId, deepCwd, "user", "more of it", at(6)));

  const blocked = run("--all");
  assert.equal(byId(blocked, slugId), undefined, "blacklisted tree skipped unread (slug layer)");
  assert.equal(byId(blocked, deepId), undefined, "lower-level repo dropped post-parse — even --all");
  assert.equal(run().count, 2, "visible set unchanged");
  assert.equal(run("--thread", slugId).count, 0, "--thread drill-in cannot reach a blacklisted thread");
  assert.equal(run("--thread", deepId).count, 0, "--thread drill-in cannot reach a lower-level one either");

  process.stdout.write("ok — scan skill: resolver join, cursor finder, origin app, git delta, blacklist\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

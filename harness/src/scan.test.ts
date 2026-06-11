// Integration test of the scan skill's resolver join — the REAL get-active-threads script
// against fake session files and a fake status store. Proves the canonical-resolver contract
// at the skill surface: operator-marked done threads are excluded by default, audit-visible
// with --include-done, drill-in always answers, and a newer message wakes the thread.
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
const sessionFile = join(home, ".claude", "projects", "demo", `${sid}.jsonl`);
const msg = (type: "user" | "assistant", content: string, ts: string) =>
  JSON.stringify({ type, sessionId: sid, cwd: "/Users/x/dev/demo-repo", timestamp: ts, message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) } }) + "\n";

mkdirSync(dirname(sessionFile), { recursive: true });
writeFileSync(
  sessionFile,
  msg("user", "ship the resolver fix", at(30)) +
  msg("assistant", "On it — wiring the resolver.", at(25)) +
  msg("user", "looks good, add tests too", at(20)) +
  msg("assistant", "Tests added; resolver join is wired.", at(10)),
);
interface ScanThread { id: string; state: string; lastMessageAt: string }
const run = (...extra: string[]): { count: number; threads: ScanThread[] } =>
  JSON.parse(execFileSync("node", [SCAN, "--since", "7d", "--json", ...extra], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  }));

try {
  // No operator state yet → the candidate passes, resolved from scan facts alone.
  const fresh = run();
  assert.equal(fresh.count, 1, "scan finds the session");
  assert.equal(fresh.threads[0].id, sid);
  assert.equal(fresh.threads[0].state, "needs-you", "assistant yielded → needs-you");

  // Operator marks it done (status.json is the durable store the resolver joins against).
  writeFileSync(join(ooHome, "status.json"), JSON.stringify({
    polledAt: at(5),
    threads: [{ id: sid, state: "done", lastMessageAt: fresh.threads[0].lastMessageAt }],
  }));

  assert.equal(run().count, 0, "done thread is excluded from a fresh scan by default");
  const audit = run("--include-done");
  assert.deepEqual([audit.count, audit.threads[0].state], [1, "done"], "--include-done audits it, resolved done");
  const drill = run("--thread", sid);
  assert.deepEqual([drill.count, drill.threads[0].state], [1, "done"], "--thread drill-in always answers");

  // A newer message lands → the same scan wakes the thread (no operator action needed).
  appendFileSync(sessionFile, msg("assistant", "One more thing came up — see the failing CI run.", at(1)));
  const woken = run();
  assert.deepEqual([woken.count, woken.threads[0].state], [1, "needs-you"], "newer message wakes a done thread");

  process.stdout.write("ok — scan skill resolves candidates against operator state\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

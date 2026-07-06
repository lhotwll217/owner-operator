// Integration test of the poller's REAL scan path — the wiring the fake-seam tests can't reach.
// StatusPoller with NO injected `scan` runs the actual scan-active-transcripts skill (poller.ts's
// runScan) over a temp $HOME holding a real Claude session, then reconciles + persists. Proves
// runScan spawns the scan, maps its JSON into ScanRow (notably `ui` → `app`, under
// --sample 0 --include-done), and the snapshot reflects session data parsed off disk.
// Hermetic: temp HOME + OO_HOME, no model. (daemon.e2e + poller.integration keep the fake
// seam on purpose — they test daemon/store mechanics, not the scan; this is where the real
// scan path earns its coverage.)
//   npm run test:integration   (from packages/gateway/)

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tempOoHome } from "../test/helpers";

const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "oo-poller-scan-home-"));
process.env.HOME = home; // the real scan reads $HOME/.claude/projects, …
const { cleanup } = tempOoHome("oo-poller-scan"); // isolated OO_HOME: the store + scan overrides

const sid = "abcdef01-2345-6789-abcd-ef0123456789";
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const cwd = join(home, "dev", "demo-repo"); // no git here → no diff badge, which is fine
const sessionFile = join(home, ".claude", "projects", "demo", `${sid}.jsonl`);
const msg = (type: "user" | "assistant", content: string, ts: string) =>
  JSON.stringify({
    type, sessionId: sid, cwd, timestamp: ts,
    message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) },
  }) + "\n";

mkdirSync(dirname(sessionFile), { recursive: true });
// A real interactive terminal session has ≥2 user turns. The scan hides a single-turn bare
// `claude` session as an indistinguishable `claude -p` one-shot (launch-mode rule in
// scan-active-transcripts.mjs), so a one-turn fixture would never surface.
writeFileSync(
  sessionFile,
  msg("user", "tighten the poll loop", at(20)) +
  msg("assistant", "On it — reworking the interval.", at(18)) +
  msg("user", "looks good, ship it", at(12)) +
  msg("assistant", "Done — the loop is tighter now.", at(8)),
);

try {
  const { StatusPoller } = await import("./poller");

  // No `scan` seam → StatusPoller runs the REAL scan-active-transcripts subprocess.
  const poller = new StatusPoller({ since: "7d", limit: 50 });
  const snap = await poller.poll();
  poller.stop();

  assert.ok(snap, "poll produced a snapshot");
  assert.equal(snap!.threads.length, 1, "the real scan found exactly the seeded session");
  const t = snap!.threads[0];
  assert.equal(t.id, sid, "thread id parsed from the session file on disk");
  assert.equal(t.app, "Claude CLI", "runScan maps the scan's `ui` field to `app`");
  assert.equal(t.state, "needs-you", "assistant yielded (end_turn) → needs-you");
  assert.ok(t.topic.includes("tighten the poll loop"), "topic carried from the first user turn");

  process.stdout.write("ok — poller real scan path: scan-active-transcripts → runScan → snapshot\n");
} finally {
  cleanup();
  rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
}

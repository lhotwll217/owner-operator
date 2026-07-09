// Integration test of the monitor's real scan path — wiring fake-seam tests cannot reach.
// SessionMonitor with no injected `scan` imports the scanner over a temp $HOME holding a real
// Claude session, then persists it. This proves --sample 0 and `ui` → `app`
// mapping use the session data parsed from disk.
// Hermetic: temp HOME + OO_HOME, no model. Daemon e2e and monitor integration keep the fake
// seam on purpose — they test daemon/state mechanics, not the scan; this is where the real
// scan path earns its coverage.)
//   npm run test:integration   (from the repo root)

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tempOoHome } from "../gateway/test/helpers";

const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "oo-monitor-scan-home-"));
process.env.HOME = home; // the real scan reads $HOME/.claude/projects, …
const { dir, cleanup } = tempOoHome("oo-monitor-scan"); // isolated OO_HOME: state + scan overrides

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
// `claude` session as an indistinguishable `claude -p` single-turn worker (launch-mode rule in
// scan-active-transcripts.mjs), so a one-turn fixture would never surface.
writeFileSync(
  sessionFile,
  msg("user", "tighten the poll loop", at(20)) +
  msg("assistant", "On it — reworking the interval.", at(18)) +
  msg("user", "looks good, ship it", at(12)) +
  msg("assistant", "Done — the loop is tighter now.", at(8)),
);

try {
  const { State } = await import("../state/state");
  const { SessionMonitor } = await import("./monitor");

  // No `scan` seam → SessionMonitor imports the real scan-active-transcripts runtime.
  const state = new State(join(dir, "state.db"));
  const monitor = new SessionMonitor(state, { since: "7d", limit: 50 });
  const current = await monitor.poll();
  monitor.stop();
  state.close();

  assert.equal(current.length, 1, "the real scan found exactly the seeded session");
  const t = current[0];
  assert.equal(t.id, sid, "thread id parsed from the session file on disk");
  assert.equal(t.app, "Claude CLI", "runScan maps the scan's `ui` field to `app`");
  assert.equal(t.state, "needs-you", "assistant yielded (end_turn) → needs-you");
  assert.ok(t.topic.includes("tighten the poll loop"), "topic carried from the first user turn");

  process.stdout.write("ok — monitor real scan path: scan-active-transcripts → current state\n");
} finally {
  cleanup();
  rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
}

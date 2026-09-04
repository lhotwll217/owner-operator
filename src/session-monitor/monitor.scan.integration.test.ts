// Integration test of the monitor's real scan path — wiring fake-seam tests cannot reach.
// SessionMonitor with no injected `scan` imports the scanner over a temp $HOME holding a real
// Claude session, then persists it. This proves --sample 0 and `ui` → `app`
// mapping use the session data parsed from disk.
// Hermetic: temp HOME + OO_HOME, no model. Daemon e2e and monitor integration keep the fake
// seam on purpose — they test daemon/state mechanics, not the scan; this is where the real
// scan path earns its coverage.)
//   npm run test:integration   (from the repo root)

import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { markOnboarded } from "@owner-operator/core";
import { tempOoHome } from "../gateway/test/helpers";

const realHome = process.env.HOME;
const realPath = process.env.PATH;
const home = mkdtempSync(join(tmpdir(), "oo-monitor-scan-home-"));
process.env.HOME = home; // the real scan reads $HOME/.claude/projects, …
const { dir, cleanup } = tempOoHome("oo-monitor-scan"); // isolated OO_HOME: state + scan overrides
markOnboarded(dir, { via: "test" });

const sid = "abcdef01-2345-6789-abcd-ef0123456789";
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const cwd = join(home, "dev", "demo-repo"); // no git here → no diff badge, which is fine
const sessionFile = join(home, ".claude", "projects", "demo", `${sid}.jsonl`);
const ooSid = "12345678-abcd-4321-abcd-1234567890ab";
const stableHeaderCwd = join(home, "install", "owner-operator");
const ooTaskCwd = join(home, "tasks", "issue-131");
const ooSessionFile = join(dir, "sessions", `2026-01-01T00-00-00-000Z_${ooSid}.jsonl`);
const msg = (type: "user" | "assistant", content: string, ts: string) =>
  JSON.stringify({
    type, sessionId: sid, cwd, timestamp: ts,
    message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) },
  }) + "\n";

mkdirSync(dirname(sessionFile), { recursive: true });
const binDir = join(home, "bin");
const slowGit = join(binDir, "git");
mkdirSync(binDir, { recursive: true });
writeFileSync(
  slowGit,
  "#!/usr/bin/env node\nconst until = Date.now() + 250; while (Date.now() < until) {} process.exit(1);\n",
);
chmodSync(slowGit, 0o755);
process.env.PATH = `${binDir}:${realPath ?? ""}`;
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
mkdirSync(dirname(ooSessionFile), { recursive: true });
writeFileSync(join(dir, "session_sources.json"), JSON.stringify({ disable: ["pi"] }));
writeFileSync(
  ooSessionFile,
  JSON.stringify({ type: "session", version: 3, id: ooSid, timestamp: at(22), cwd: stableHeaderCwd }) + "\n" +
  JSON.stringify({ type: "custom", customType: "oo-provenance", timestamp: at(21), data: {
    surface: "chat", origin: "owner", callerCwd: ooTaskCwd, callerRepo: "issue-131", ppid: 10,
  } }) + "\n" +
  JSON.stringify({ type: "message", timestamp: at(20), message: { role: "user", content: "monitor the Owner Operator root" } }) + "\n" +
  JSON.stringify({ type: "message", timestamp: at(7), message: {
    role: "assistant", content: [{ type: "text", text: "The root is monitored." }], stopReason: "stop",
  } }) + "\n",
);

try {
  const { State } = await import("../state/state");
  const { SessionMonitor } = await import("./monitor");

  // No `scan` seam → SessionMonitor imports the real scan-active-transcripts runtime.
  const state = new State(join(dir, "state.db"));
  const monitor = new SessionMonitor(state, { since: "7d", limit: 50 });
  const timer = new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 20));
  const polling = monitor.poll();
  assert.equal(
    await Promise.race([timer, polling.then(() => "poll" as const)]),
    "timer",
    "the real transcript scan does not block the daemon event loop",
  );
  const current = await polling;
  monitor.stop();
  state.close();
  const { runQuery } = await import("../state/query");
  const stored = runQuery(
    `SELECT transcript_path FROM threads WHERE id = '${sid}'`,
    join(dir, "state.db"),
  );

  assert.equal(current.length, 2, "the real scan found the external and product-owned sessions");
  const t = current.find((row) => row.id === sid)!;
  assert.equal(t.id, sid, "thread id parsed from the session file on disk");
  assert.equal(t.app, "Claude CLI", "runScan maps the scan's `ui` field to `app`");
  assert.equal(t.state, "needs-you", "assistant yielded (end_turn) → needs-you");
  assert.ok(t.topic.includes("tighten the poll loop"), "topic carried from the first user turn");
  assert.equal(
    stored.rows[0]?.transcript_path,
    sessionFile,
    "the real scan persists its transcript path through monitor and State",
  );

  const oo = current.find((row) => row.id === ooSid)!;
  assert.equal(oo.source, "pi", "OO retains its actual transcript format");
  assert.equal(oo.app, "Owner Operator", "the product store supplies owner-facing attribution");
  assert.equal(oo.repo, "issue-131", "OO provenance wins over the stable session-header cwd");
  const ooStored = runQuery(
    `SELECT app, source, project, transcript_path FROM threads WHERE id = '${ooSid}'`,
    join(dir, "state.db"),
  ).rows[0];
  assert.deepEqual(ooStored, {
    app: "Owner Operator", source: "pi", project: ooTaskCwd, transcript_path: ooSessionFile,
  }, "OO identity and task attribution persist through the ordinary threads row");
  assert.equal(
    runQuery(`SELECT COUNT(*) AS count FROM thread_details WHERE thread_id = '${ooSid}'`, join(dir, "state.db")).rows[0]?.count,
    1,
    "the OO root receives an ordinary append-only detail version",
  );

  process.stdout.write("ok — monitor real scan path: scan-active-transcripts → current state\n");
} finally {
  cleanup();
  rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
}

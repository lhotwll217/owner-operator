// An explicit turn end in the transcript decides a session's state before the last speaker does,
// through the daemon's real path: SessionMonitor runs the real scanner over a temp $HOME and State
// resolves and persists each row. Record sequences mirror the session-event contract's S0, S3, and
// S3b fixtures, captured from Claude Code 2.1.280 and `codex exec`, with invented text.
import assert from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markOnboarded } from "@owner-operator/core";
import { tempOoHome } from "../gateway/test/helpers";

const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "oo-turn-end-home-"));
process.env.HOME = home;
const { dir, cleanup } = tempOoHome("oo-turn-end");
markOnboarded(dir, { via: "test" });

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
const ID = {
  ended: "55555555-5555-4555-8555-555555555555",
  interrupted: "11111111-1111-4111-8111-111111111111",
  interruptedText: "12121212-1212-4121-8121-121212121212",
  quoted: "88888888-8888-4888-8888-888888888888",
  codexAborted: "77777777-7777-4777-8777-777777777777",
  codexCompleted: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const claudeDir = join(home, ".claude", "projects", "-tmp-turn-end");
const claudeLine = (id: string, i: number, record: Record<string, unknown>, ts: string): string => JSON.stringify({
  sessionId: id, uuid: `${id.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, "0")}`,
  cwd: "/tmp/turn-end", entrypoint: "cli", timestamp: ts, ...record,
}) + "\n";
const writeClaude = (id: string, records: Record<string, unknown>[]): void => {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, `${id}.jsonl`), records.map((record, i) => claudeLine(id, i, record, ago(120 - i))).join(""));
};
const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (stop: string, content: unknown[]) => ({ type: "assistant", message: { role: "assistant", stop_reason: stop, content } });
const toolUse = { type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } };
const toolResult = user([{ type: "tool_result", tool_use_id: "t1", content: "interrupted" }]);

writeClaude(ID.ended, [user("Summarise the build log"), assistant("end_turn", [{ type: "text", text: "Summary written." }])]);
const interruptedRecords = [user("Run the long build"), assistant("tool_use", [{ type: "text", text: "Starting." }, toolUse]),
  toolResult, user([{ type: "text", text: "[Request interrupted by user for tool use]" }])];
writeClaude(ID.interrupted, interruptedRecords);
writeClaude(ID.interruptedText, [user("Explain the build"), user([{ type: "text", text: "[Request interrupted by user]" }])]);
writeClaude(ID.quoted, [user("Summarise the build log"), assistant("end_turn", [{ type: "text", text: "Summary written." }]),
  user([{ type: "text", text: "Why did the log say [Request interrupted by user] at the end?" }])]);

const writeCodex = (id: string, lifecycle: string[]): void => {
  const codexDir = join(home, ".codex", "sessions", "2026", "11", "24");
  mkdirSync(codexDir, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id, cwd: "/tmp/turn-end", originator: "codex_cli_rs" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Summarise the build log" }] } },
    ...lifecycle.map((type) => ({ type: "event_msg", payload: { type } })),
  ];
  writeFileSync(join(codexDir, `rollout-2026-11-24T10-00-00-${id}.jsonl`),
    lines.map((line, i) => JSON.stringify({ timestamp: ago(120 - i), ...line })).join("\n") + "\n");
};
writeCodex(ID.codexAborted, ["turn_aborted"]);
writeCodex(ID.codexCompleted, ["task_complete"]);

try {
  const { State } = await import("../state/state");
  const { SessionMonitor } = await import("./monitor");
  const state = new State(join(dir, "state.db"));
  const monitor = new SessionMonitor(state, { since: "1d", limit: 0 });
  try {
    const stateOf = (rows: { id: string; state: string }[], id: string): string => {
      const row = rows.find((r) => r.id === id);
      assert.ok(row, `${id} reached State`);
      return row.state;
    };

    let rows = await monitor.poll();
    assert.equal(stateOf(rows, ID.ended), "idle", "S0 a normal Claude end reads idle");
    assert.equal(stateOf(rows, ID.interrupted), "idle", "S3 a Claude interrupt during a tool ends the turn with the owner last");
    assert.equal(stateOf(rows, ID.interruptedText), "idle", "a Claude interrupt before any reply ends the turn");
    assert.equal(stateOf(rows, ID.codexAborted), "idle", "S3b a Codex turn_aborted before any reply ends the turn");
    assert.equal(stateOf(rows, ID.codexCompleted), "idle", "a Codex task_complete with no reply ends the turn");
    assert.equal(stateOf(rows, ID.quoted), "working", "an owner message that quotes the marker is a new turn, not an interrupt");

    appendFileSync(join(claudeDir, `${ID.interrupted}.jsonl`),
      claudeLine(ID.interrupted, interruptedRecords.length, user("Run only the tests instead"), ago(10)));
    rows = await monitor.poll();
    assert.equal(stateOf(rows, ID.interrupted), "working", "a new owner prompt after the interrupt opens a new turn");
  } finally {
    monitor.stop();
    state.close();
  }
  process.stdout.write("ok — explicit turn ends reach State: Claude interrupt markers, Codex lifecycle, quoted marker, resumed turn\n");
} finally {
  cleanup();
  rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
}

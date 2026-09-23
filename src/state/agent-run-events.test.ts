// Unit: the per-run event log — appended only while running, closed by exactly one terminal
// record on every finalization path, served in order, and bounded oldest-first.
import assert from "node:assert";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { ThreadDb } from "./database";

const db = new ThreadDb(":memory:", { eventLogMaxBytes: 400 });
const insert = (id: string) => db.createAgentRun({
  id, harness: AgentRunHarness.ClaudeCode, task: "t", cwd: "/tmp", depth: 1, timeoutSeconds: 60,
});
const types = (id: string) => db.agentRunEvents(id).map(({ record }) => record.type);

insert("a");
assert.equal(db.appendAgentRunEvent("a", { type: "text_delta", text: "early" }), null, "a pending run has no stream yet");
db.claimNextPendingAgentRun(3);
assert.equal(db.appendAgentRunEvent("a", { type: "text_delta", text: "hi" }), 1);
assert.equal(db.appendAgentRunEvent("a", { type: "tool_call", text: "read", toolCallId: "t1" }), 2);
db.finishAgentRun("a", { status: AgentRunStatus.Completed, resultTail: "hi", error: null });
assert.deepEqual(db.agentRunEvents("a").map(({ seq, record }) => [seq, record]), [
  [1, { type: "text_delta", text: "hi" }],
  [2, { type: "tool_call", text: "read", toolCallId: "t1" }],
  [3, { type: "result", runId: "a", status: AgentRunStatus.Completed }],
], "stored verbatim, in order, closed by one result record");
assert.equal(db.appendAgentRunEvent("a", { type: "text_delta", text: "late" }), null, "a terminal run's log is closed");
assert.deepEqual(db.agentRunEvents("a", 2).map(({ seq }) => seq), [3], "reads resume after a sequence number");

insert("b");
db.claimNextPendingAgentRun(3);
db.markRunningAgentRunsInterrupted("daemon restarted during execution");
assert.deepEqual(db.agentRunEvents("b").map(({ record }) => record), [{
  type: "result", runId: "b", status: AgentRunStatus.Interrupted, error: { message: "daemon restarted during execution" },
}], "restart interruption closes the log");

insert("c");
db.claimNextPendingAgentRun(3);
db.markAgentRunsLost([], "9999-01-01T00:00:00.000Z");
assert.deepEqual(types("c"), ["result"], "the lost sweep closes the log");

insert("d");
db.finishAgentRun("d", { status: AgentRunStatus.Cancelled, resultTail: null, error: "cancelled before start" });
assert.deepEqual(types("d"), ["result"], "cancelling a pending run closes the log");

insert("e");
db.claimNextPendingAgentRun(3);
for (let index = 0; index < 20; index++) db.appendAgentRunEvent("e", { type: "text_delta", text: `chunk-${index}` });
db.finishAgentRun("e", { status: AgentRunStatus.Completed, resultTail: null, error: null });
const kept = db.agentRunEvents("e");
assert.ok(kept.length < 21, "the byte budget evicted events");
assert.equal((kept.at(-2)!.record as { text?: string }).text, "chunk-19", "the newest events survive");
assert.equal(kept.at(-1)?.record.type, "result", "the terminal record is never evicted");
assert.ok(kept.every((entry, index) => index === 0 || entry.seq === kept[index - 1]!.seq + 1), "no gaps after the evicted prefix");

// Full eviction (one event larger than the budget) never restarts numbering, so a follower that
// already saw a sequence number cannot miss later events.
const tiny = new ThreadDb(":memory:", { eventLogMaxBytes: 100 });
tiny.createAgentRun({ id: "f", harness: AgentRunHarness.ClaudeCode, task: "t", cwd: "/tmp", depth: 1, timeoutSeconds: 60 });
tiny.claimNextPendingAgentRun(3);
assert.deepEqual([
  tiny.appendAgentRunEvent("f", { type: "text_delta", text: "a" }),
  tiny.appendAgentRunEvent("f", { type: "text_delta", text: "x".repeat(500) }),
  tiny.appendAgentRunEvent("f", { type: "text_delta", text: "b" }),
], [1, 2, 3], "sequence numbers stay monotonic across full eviction");
tiny.finishAgentRun("f", { status: AgentRunStatus.Completed, resultTail: null, error: null });
assert.deepEqual(tiny.agentRunEvents("f", 2).map(({ seq, record }) => [seq, record.type]), [[3, "text_delta"], [4, "result"]],
  "a follower after seq 2 still receives the next event and the terminal record");

process.stdout.write("ok — agent-run event log: running-only appends, one terminal record per finalization, ordered, bounded\n");

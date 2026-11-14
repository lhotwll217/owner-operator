import assert from "node:assert/strict";
import { join } from "node:path";
import { AgentRunHarness, type EnrichmentCandidate, type SessionStateRow, type ThreadEnrichment } from "@owner-operator/core";
import { State } from "../state/state";
import { startGateway } from "./server";
import { fakeScanRow, tempOoHome } from "./test/helpers";

const { dir, cleanup } = tempOoHome("oo-stopped-hook-attention");
const dbPath = join(dir, "state.db");
const state = new State(dbPath);
const gateway = await startGateway({
  authToken: "test-token", state, port: 0,
  monitor: { poll: async () => [] },
  health: () => ({ ok: true, port: gateway.port, pid: process.pid, startedAt: "now", fingerprint: "test", stale: false, repoRoot: "/test" }),
  ready: () => ({ ready: true, setupRequired: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }),
  scheduler: {} as never, agentRuns: {} as never, worktrees: {} as never, query: {} as never, harness: {} as never, search: {} as never,
});
const endpoint = `http://127.0.0.1:${gateway.port}`;
const stamp = new Date().toISOString();

async function hook(id: string, hook_event_name: string, fields: Record<string, unknown> = {}): Promise<void> {
  const response = await fetch(`${endpoint}/hooks/claude`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ session_id: id, hook_event_name, ...fields }),
  });
  assert.equal(response.status, 200);
}

async function row(id: string): Promise<SessionStateRow | undefined> {
  const response = await fetch(`${endpoint}/session-state`, { headers: { authorization: "Bearer test-token" } });
  assert.equal(response.status, 200);
  const rows: SessionStateRow[] = await response.json();
  return rows.find((item) => item.id === id);
}

function candidate(id: string): EnrichmentCandidate {
  const found = state.listEnrichmentCandidates().find((item) => item.id === id);
  assert.ok(found, `${id} has fresh evidence to assess`);
  return found;
}

function assess(sample: EnrichmentCandidate, details: ThreadEnrichment): boolean {
  assert.ok(sample.lastMessageAt);
  return state.appendEnrichment(sample.id, details, sample.lastMessageAt, sample.children, sample.hookRevision);
}

const unfinished = { topic: "Review the repair", statusSummary: "The repair needs the owner's review.", attention: "needs-you", awaiting: false } satisfies ThreadEnrichment;
const finished = { topic: "Completed repair", statusSummary: "The repair and verification are complete.", attention: "idle", awaiting: false } satisfies ThreadEnrichment;

async function stopped(id: string): Promise<void> {
  await hook(id, "UserPromptSubmit", { prompt: "Complete and verify the repair" });
  state.recordObservation(fakeScanRow({ id, lastMessageAt: stamp }));
  await hook(id, "Stop");
}

try {
  await stopped("review");
  assert.equal(assess(candidate("review"), unfinished), true);
  assert.equal((await row("review"))?.state, "needs-you", "unfinished stopped hook work still needs its owner");
  state.recordObservation(fakeScanRow({ id: "review", lastMessageAt: stamp, working: true, lastRole: "user" }));
  assert.equal((await row("review"))?.state, "needs-you", "a same-message scan cannot erase the task assessment");
  await hook("review", "SessionStart", { source: "compact" });
  await hook("review", "Stop");
  assert.equal((await row("review"))?.state, "needs-you", "idle continuation and duplicate Stop preserve Need You");
  assert.ok(!state.listEnrichmentCandidates().some((item) => item.id === "review"), "duplicate idle facts do not request another settled assessment");

  const reopened = new State(dbPath);
  assert.equal(reopened.listSessionState().find((item) => item.id === "review")?.state, "needs-you", "the task assessment survives restart");
  reopened.close();

  await stopped("complete");
  assert.equal(assess(candidate("complete"), finished), true);
  assert.equal((await row("complete"))?.state, "idle", "a completed hooked task stays Idle");

  await stopped("attention-only");
  assert.equal(assess(candidate("attention-only"), { attention: "needs-you" }), true);
  state.recordObservation(fakeScanRow({ id: "attention-only", lastMessageAt: stamp }));
  assert.equal((await row("attention-only"))?.state, "needs-you", "an unchanged scan preserves attention when title generation failed");
  assert.ok(state.listEnrichmentCandidates().some((item) => item.id === "attention-only"), "the failed account remains eligible to retry");

  await stopped("race");
  const stale = candidate("race");
  await hook("race", "UserPromptSubmit", { prompt: "Continue the repair" });
  await hook("race", "Stop");
  assert.equal(assess(stale, unfinished), false, "hook-only resumed activity invalidates a previous stopped assessment");
  assert.equal(assess(candidate("race"), unfinished), true);
  assert.equal((await row("race"))?.state, "needs-you");

  await stopped("wait");
  const beforeWait = candidate("wait");
  await hook("wait", "PermissionRequest", { tool_name: "Write" });
  assert.equal(assess(beforeWait, { ...finished, awaiting: true }), false, "a late model answer cannot replace a permission wait");
  assert.equal((await row("wait"))?.state, "needs-you");
  assert.equal(assess(candidate("wait"), { topic: "Permission", statusSummary: "Waiting for Write approval." }), true,
    "a live permission can still receive its title and status without classification");
  await hook("wait", "UserPromptSubmit", { prompt: "Continue" });
  await hook("wait", "PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "question" });
  assert.equal((await row("wait"))?.state, "needs-you", "a live question still needs the owner");

  await hook("late-stop", "UserPromptSubmit", { prompt: "Finish" });
  state.recordObservation(fakeScanRow({ id: "late-stop", lastMessageAt: stamp }));
  const working = candidate("late-stop");
  assert.equal(assess(working, { topic: "Repair", statusSummary: "The repair is running." }), true);
  await hook("late-stop", "Stop");
  assert.equal(assess(working, { topic: "Old repair", statusSummary: "Still running." }), false,
    "an account sampled before Stop cannot mark the stopped phase fresh");
  assert.equal(assess(candidate("late-stop"), unfinished), true, "Stop after the final scan requests a stopped assessment");

  await stopped("background");
  assert.equal(assess(candidate("background"), { ...unfinished, awaiting: true }), true);
  assert.equal((await row("background"))?.state, "working", "a stopped agent waiting on its own background work stays Working");
  state.recordObservation(fakeScanRow({ id: "background", lastMessageAt: stamp }));
  await hook("background", "SessionStart", { source: "compact" });
  assert.equal((await row("background"))?.state, "working", "unchanged scans and idle hooks preserve awaiting work");
  await hook("background", "PermissionRequest", { tool_name: "Bash" });
  assert.equal((await row("background"))?.state, "needs-you", "a real hook wait outranks model awaiting work");

  await hook("native", "UserPromptSubmit", { prompt: "Run a child" });
  await hook("native", "SubagentStart", { agent_id: "native-child" });
  state.recordObservation(fakeScanRow({ id: "native", lastMessageAt: stamp }));
  await hook("native", "Stop");
  assert.equal((await row("native"))?.state, "working", "live native child work holds Working after the lead stops");

  await stopped("parent");
  const beforeChild = candidate("parent");
  state.recordObservation(fakeScanRow({ id: "delegated", lastMessageAt: stamp }));
  state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "Check repair", cwd: dir,
    parentThreadId: "parent", childSessionId: "delegated", depth: 1, timeoutSeconds: 60 });
  assert.equal(assess(beforeChild, finished), false, "a new child invalidates a stopped assessment");
  assert.equal((await row("parent"))?.state, "working");
  const childWorking = candidate("parent");
  await hook("delegated", "PermissionRequest", { tool_name: "Bash" });
  assert.equal(assess(childWorking, { topic: "Old account", statusSummary: "The child is working." }), false,
    "a child's hook-only wait invalidates the parent's in-flight account");
  assert.equal((await row("parent"))?.state, "needs-you", "a child wait needs its owner through the parent");

  await stopped("done");
  const beforeDone = candidate("done");
  state.markThreadsDone(["done"]);
  assert.equal(assess(beforeDone, unfinished), false, "owner Done rejects a late assessment");
  await hook("done", "Stop");
  assert.equal(await row("done"), undefined, "a duplicate Stop does not undo owner Done");

  state.recordObservation(fakeScanRow({ id: "unhooked", lastMessageAt: stamp }));
  assert.equal(assess(candidate("unhooked"), unfinished), true);
  assert.equal((await row("unhooked"))?.state, "needs-you", "unhooked classification retains its behavior");

  await hook("failed", "StopFailure");
  assert.equal((await row("failed"))?.state, "needs-you", "failed turns retain deterministic Need You");
  console.log("ok - stopped hook tasks keep classified attention and reject stale lifecycle evidence");
} finally {
  await gateway.close();
  state.close();
  cleanup();
}

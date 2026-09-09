import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRunHarness, AgentRunStatus, markOnboarded, type EnrichmentCandidate, type ThreadDetails, type SessionStateRow } from "@owner-operator/core";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { State } from "../src/state/state";
import { fakeScanRow, waitFor } from "../src/gateway/test/helpers";

const originalHome = process.env.HOME;
const originalOoHome = process.env.OO_HOME;
const live = process.env.OO_WIDGET_PROOF_LIVE === "1";
const credentialSource = process.env.OO_WIDGET_PROOF_CREDENTIAL_SOURCE;
if (live && !credentialSource) throw new Error("live proof requires an explicit credential source directory");
const root = mkdtempSync(join(tmpdir(), "oo-widget-proof-"));
process.env.HOME = join(root, "home");
process.env.OO_HOME = join(root, "operator");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.OO_HOME, { recursive: true });
writeFileSync(join(process.env.OO_HOME, "settings.json"), JSON.stringify({ activeWindow: "1d" }));
markOnboarded(process.env.OO_HOME, { via: "test" });
if (live && credentialSource) {
  const pi = join(process.env.OO_HOME, "pi");
  mkdirSync(pi, { recursive: true, mode: 0o700 });
  for (const file of ["auth.json", "models-store.json"]) {
    copyFileSync(join(credentialSource, file), join(pi, file));
    chmodSync(join(pi, file), 0o600);
  }
}
const dbPath = join(process.env.OO_HOME, "state.db");
const project = join(root, "project");
const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
const oldAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
const cases = [
  { id: "child", request: "Review the implementation against the spec. Report findings. Do not implement anything.", answer: "Review complete. No findings. All requested checks passed. No remaining work or owner decision.", state: "done", topic: "Completed spec review" },
  { id: "decision", request: "Build the export.", answer: "Implementation requires the retention policy. Should exports retain 30 or 90 days? The owner must choose before work can continue.", state: "needs-you", topic: "Export retention decision" },
  { id: "partial", request: "Implement and verify the export.", answer: "I have started reading the files. Implementation and verification are not complete. I have no question for the owner yet.", state: "idle", topic: "Unfinished export implementation" },
  { id: "summarized", request: "Remove the unused import and run the typecheck.", answer: "The unused import is removed and typecheck passed. The requested task is complete with no remaining work or required owner action.", state: "done", topic: "Completed import cleanup" },
  { id: "owner-done", request: "Investigate an optional follow-up.", answer: "I can investigate further.", state: "idle", topic: "Owner dismissed follow-up" },
] as const;
function transcript(id: string, request: string, answer: string, timestamp = at, working = false) {
  const file = join(process.env.HOME!, ".codex", "sessions", `${id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const records = [
    { type: "session_meta", payload: { id, cwd: project, source: "cli" } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ text: request }] } },
    ...(id === "child" || id === "summarized" ? [
      { type: "response_item", timestamp, payload: { type: "function_call", name: "exec_command", call_id: `${id}-check`, arguments: JSON.stringify({ cmd: id === "child" ? "cat spec.md; git diff; npm test" : "git diff -- src/export.ts; npm run typecheck" }) } },
      { type: "response_item", timestamp, payload: { type: "function_call_output", call_id: `${id}-check`, output: id === "child" ? "spec.md: Export retains exactly 30 days.\nDiff: retainDays changed from 90 to 30. No other changes.\nPASS export retention matches spec: 30 days. Tests 1 passed, 0 failed. Exit code 0." : "diff --git a/src/export.ts b/src/export.ts\n-import { unused } from './unused';\nRemaining code unchanged.\n> tsc --noEmit\nExit code 0. No errors." } },
    ] : []),
    { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ text: answer }] } },
    { type: "event_msg", timestamp, payload: { type: working ? "task_started" : "task_complete" } },
  ];
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(file, new Date(timestamp), new Date(timestamp));
}
for (const c of cases.filter((item) => item.id !== "partial" && item.id !== "decision")) transcript(c.id, c.request, c.answer);
for (const id of ["partial", "parent"]) {
  const file = join(process.env.OO_HOME!, "sessions", `${id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const c = cases.find((item) => item.id === id);
  writeFileSync(file, [
    { type: "session", version: 3, id, timestamp: at, cwd: project },
    { type: "custom", customType: "oo-provenance", timestamp: at, data: { surface: "chat", origin: "owner", callerCwd: project, callerRepo: "demo", ppid: 1 } },
    { type: "message", timestamp: at, message: { role: "user", content: c?.request ?? "Use the replacement agent." } },
    { type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: c?.answer ?? "The replacement is working." }], stopReason: id === "parent" ? "toolUse" : "stop" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
}
const decision = cases.find((c) => c.id === "decision")!;
const claudeFile = join(process.env.HOME!, ".claude", "projects", "demo", "decision.jsonl");
mkdirSync(dirname(claudeFile), { recursive: true });
writeFileSync(claudeFile, [
  { type: "user", entrypoint: "claude-desktop", sessionId: "decision", cwd: project, timestamp: at, message: { content: decision.request } },
  { type: "assistant", sessionId: "decision", timestamp: at, message: { content: [{ type: "text", text: decision.answer }], stop_reason: "end_turn" } },
].map((record) => JSON.stringify(record)).join("\n") + "\n");
transcript("outside-window", "Old quiet investigation", "No decision requested", oldAt);
const seed = new State(dbPath);
for (const id of [...cases.map((c) => c.id), "parent", "outside-window"]) {
  const timestamp = id === "outside-window" ? oldAt : at;
  seed.recordObservation(fakeScanRow({ id, project, source: "codex", lastMessageAt: timestamp, createdAt: timestamp, secondsSinceLastMessage: 7200 }));
}
for (const id of ["parent", "summarized"]) {
  assert.ok(seed.appendEnrichment(id, { topic: "Stale review instruction", nextSteps: "Review and confirm the task" }, at));
}
seed.markThreadsDone(["owner-done"]);
const run = seed.createAgentRun({ harness: AgentRunHarness.Codex, task: "Review the implementation", cwd: project, parentThreadId: "parent", childSessionId: "child", depth: 1, timeoutSeconds: 60 });
seed.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: "Review complete. No findings.", error: null });
console.log("BEFORE", JSON.stringify(seed.listCurrentSessionState().map((r) => ({ id: r.id, title: r.topic, state: r.state, next: r.nextSteps }))));
const windowPreserved = !seed.listCurrentSessionState().some((r) => r.id === "outside-window");
seed.close();
let daemon: RunningDaemon | undefined;
let enabled = false;
let failOnce = true;
const attempts: string[] = [];
const errors: string[] = [];
const liveEnrich = live ? (await import("../src/agent/enrichment")).enrichThread : undefined;
async function enrich(candidate: EnrichmentCandidate): Promise<ThreadDetails> {
  attempts.push(candidate.id);
  if (candidate.id === "partial" && failOnce) { failOnce = false; throw new Error("controlled transient outage"); }
  const c = cases.find((item) => item.id === candidate.id);
  assert.ok(c, `unexpected reconciliation outside the visible test set: ${candidate.id}`);
  const { sampleTranscript } = await import("../src/session-monitor/scan");
  const sample = await sampleTranscript(candidate.id, candidate.source);
  if (candidate.id === "child" || candidate.id === "summarized") {
    assert.ok(sample.includes("Exit code 0"), "reconciliation receives execution evidence, not just the assistant's completion claim");
  }
  if (liveEnrich) {
    const result = await liveEnrich(sample);
    console.log("MODEL", candidate.id, JSON.stringify(result));
    return result;
  }
  return { topic: c.topic, state: c.state, stateReason: c.answer, nextSteps: c.state === "needs-you" ? "Choose 30 or 90 days of retention" : "", priority: 2 };
}
async function boot() {
  return startDaemon({ port: 0, watch: false, dbPath,
    agentRuns: { launcher: async () => { throw new Error("proof must never launch an agent"); } },
    monitor: { intervalMs: 60_000, canEnrich: () => enabled, enrich, logger: (r) => errors.push(r.error) },
  });
}
async function api(path: string, body?: unknown) {
  const info = JSON.parse(readFileSync(join(process.env.OO_HOME!, "daemon.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${info.authToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200, path);
  return response.json();
}
try {
  assert.ok(windowPreserved, "configured widget window must not widen");
  daemon = await boot();
  await api("/poll", {});
  await waitFor(() => daemon!.state.listCurrentSessionState().some((r) => r.id === "parent" && r.state === "working"), 10_000, "startup scan observes working parent");
  const before: SessionStateRow[] = await api("/session-state");
  assert.equal(before.find((r) => r.id === "partial")?.app, "Owner Operator", "real OO transcript adapter participates in recovery");
  assert.equal(before.find((r) => r.id === "decision")?.source, "claude", "real Claude transcript adapter participates in recovery");
  assert.ok(before.some((r) => r.id === "child" && r.parentThreadId === "parent" && !r.generatedTopic), "stale delegated child is actually in the widget response before recovery");
  assert.equal(before.find((r) => r.id === "parent")?.nextSteps, null, "working parent suppresses obsolete owner instructions");
  enabled = true;
  const recovery = await api("/poll", { reconcile: [{ id: "summarized", lastMessageAt: at }, { id: "outside-window", lastMessageAt: oldAt }, { id: "owner-done", lastMessageAt: at }] });
  assert.deepEqual(recovery.queuedIds, ["summarized"], "recovery touches only eligible visible rows");
  await waitFor(() => errors.some((e) => e.includes("controlled transient outage")), live ? 180_000 : 10_000, "first failed idle reconciliation");
  await waitFor(() => daemon!.state.listEnrichmentCandidates().length === 1, live ? 180_000 : 10_000, "first pass drains except failed partial work");
  await api("/poll", {});
  await waitFor(() => daemon!.state.listEnrichmentCandidates().length === 0, live ? 90_000 : 10_000, "failed idle row retries");
  const after: SessionStateRow[] = await api("/session-state");
  console.log("AFTER", JSON.stringify(after.map((r) => ({ id: r.id, title: r.topic, state: r.state, next: r.nextSteps }))));
  assert.deepEqual(after.map((r) => r.id).sort(), ["decision", "parent", "partial"]);
  assert.equal(after.find((r) => r.id === "decision")?.state, "needs-you");
  assert.ok(after.find((r) => r.id === "decision")?.nextSteps);
  assert.equal(after.find((r) => r.id === "partial")?.state, "idle");
  assert.equal(after.find((r) => r.id === "partial")?.nextSteps, "");
  assert.ok(after.find((r) => r.id === "partial")?.generatedTopic);
  assert.equal(attempts.filter((id) => id === "partial").length, 2);
  assert.ok(!attempts.includes("outside-window"));
  const count = attempts.length;
  await daemon.close();
  daemon = await boot();
  await api("/poll", {});
  assert.deepEqual((await api("/session-state") as SessionStateRow[]).map((r) => r.id).sort(), ["decision", "parent", "partial"]);
  assert.equal(attempts.length, count, "restart does not re-enrich unchanged evidence or reopen done work");
  console.log(`PASS isolated daemon HTTP widget contract; ${live ? "live Luna medium" : "deterministic model seam"}; idle retry, delegated child, stale-summary recovery, owner decision, window, done, restart`);
} finally {
  await daemon?.close();
  rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalOoHome === undefined) delete process.env.OO_HOME; else process.env.OO_HOME = originalOoHome;
}

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { State } from "../state/state";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { sampleEnrichment } from "./scan";
import { SessionMonitor } from "./monitor";

const { dir, cleanup } = tempOoHome("oo-child-sampling");
const previousHome = process.env.HOME;
process.env.HOME = dir;
let time = Date.now();
const state = new State(join(dir, "state.db"), { now: () => new Date(time++).toISOString() });
try {
  const root = join(dir, ".codex", "sessions");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(dir, "session_sources.json"), JSON.stringify({ disable: ["claude", "cursor", "pi"], add: [] }));
  function transcript(id: string) {
    const at = new Date(time).toISOString();
    writeFileSync(join(root, `${id}.jsonl`), [
      { type: "session_meta", payload: { id, cwd: join(dir, id), source: "cli" } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ text: `${id} CURRENT_WORK_SENTINEL ${"task detail ".repeat(2000)}` }] } },
      ...Array.from({ length: 40 }, (_, index) => ({ type: "response_item", timestamp: at, payload: { type: "message", role: index % 2 ? "assistant" : "user", content: [{ text: `${id} CURRENT_WORK_SENTINEL ${index} ${"progress detail ".repeat(2000)}` }] } })),
    ].map((record) => JSON.stringify(record)).join("\n"));
    state.recordObservation(fakeScanRow({ id, source: "codex", lastMessageAt: at, working: true }));
  }
  transcript("parent");
  for (const id of ["older-running", "older-pending", ...Array.from({ length: 20 }, (_, i) => `completed-${i}`)]) {
    transcript(id);
    const run = state.createAgentRun({ harness: AgentRunHarness.Codex, task: id, cwd: dir, parentThreadId: "parent", childSessionId: id, depth: 1, timeoutSeconds: 60 });
    if (id === "older-running") state.claimNextPendingAgentRun(1);
    if (id.startsWith("completed")) state.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: `${"result detail ".repeat(2000)}${id} RESULT_TAIL_SENTINEL`, error: null });
  }
  const runById = (runId: string) => state.agentRunById(runId);
  const candidate = state.listEnrichmentCandidates().find(({ id }) => id === "parent")!;
  assert.ok(candidate.children.slice(0, 2).every((child) => child.status === "running" || child.status === "pending"), "State prioritizes active child versions before terminal history");
  const { sample, bookmark } = await sampleEnrichment(candidate, runById);
  console.log(JSON.stringify({ chars: sample.length, headers: (sample.match(/Delegated child /g) ?? []).length, olderActivePresent: sample.includes("older-running CURRENT_WORK_SENTINEL"), bookmark }));
  assert.match(sample, /older-running CURRENT_WORK_SENTINEL/, "older active work survives newer terminal siblings");
  assert.match(sample, /older-pending CURRENT_WORK_SENTINEL/, "multiple active children share the bounded context");
  assert.ok(sample.indexOf("Delegated child older-running") < sample.indexOf("Delegated child completed"));
  assert.match(sample, /completed-19 RESULT_TAIL_SENTINEL/, "a finished child is assessed from the end of its stored result");
  assert.ok(sample.length <= 48_000, "parent, children, headers and omission notice fit the context bound");
  assert.match(sample, /terminal child results omitted.*context limit/i, "omitted evidence is explicitly identified as incomplete");
  const details = { topic: "Active child progress", statusSummary: "Active children continue; terminal history was omitted from the bounded sample.", attention: "idle" as const };
  assert.ok(state.appendEnrichment(candidate.id, details, candidate.lastMessageAt!, candidate.children));
  transcript("completed-0");
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === "parent"), "even an omitted child's new message invalidates the bounded assessment");
  assert.equal(state.appendEnrichment(candidate.id, details, candidate.lastMessageAt!, candidate.children), false, "the full version snapshot guards races rather than claiming full transcript coverage");

  writeFileSync(join(dir, "blacklist.json"), JSON.stringify({ paths: [join(dir, "older-running")], repos: [] }));
  await assert.rejects(sampleEnrichment(candidate, runById), /authorized evidence|blacklist|No session/i, "active priority cannot bypass transcript privacy");
  writeFileSync(join(dir, "blacklist.json"), JSON.stringify({ paths: [], repos: [] }));

  transcript("ledger-parent");
  for (const id of ["unscanned-completed", "unscanned-pending"]) {
    const run = state.createAgentRun({ harness: AgentRunHarness.Codex, task: id, cwd: dir, parentThreadId: "ledger-parent", childSessionId: id, depth: 1, timeoutSeconds: 60 });
    if (id === "unscanned-completed") state.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: "LEDGER_RESULT_SENTINEL", error: null });
  }
  const ledgerOnly = await sampleEnrichment(state.listEnrichmentCandidates().find(({ id }) => id === "ledger-parent")!, runById);
  assert.match(ledgerOnly.sample, /Delegated child unscanned-completed, run \S+, status completed/, "a finished child known only to the ledger is reported with its status");
  assert.match(ledgerOnly.sample, /status completed\n[^]*LEDGER_RESULT_SENTINEL/, "a finished child known only to the ledger is assessed from its stored result");
  assert.match(ledgerOnly.sample, /Delegated child unscanned-pending, run \S+, status pending/, "an active child known only to the ledger is reported with its status");

  for (let i = 0; i < 24; i++) {
    const id = `pending-${i}`;
    transcript(id);
    state.createAgentRun({ harness: AgentRunHarness.Codex, task: id, cwd: dir, parentThreadId: "parent", childSessionId: id, depth: 1, timeoutSeconds: 60 });
  }
  const errors: string[] = [];
  const monitor = new SessionMonitor(state, { scan: async () => [], logger: ({ error }) => errors.push(error), enrich: async (row) => {
    if (row.id === "parent") await sampleEnrichment(row, runById);
    return details;
  } });
  try {
    await monitor.poll();
    await waitFor(() => errors.some((error) => error.includes("active child evidence exceeds")), 10_000, "too many active children fail bounded sampling");
    assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === "parent"), "unrepresented active work cannot advance the parent freshness watermark");
  } finally { monitor.stop(); }
  console.log("ok - active child sampling survives terminal history within the context bound");
} finally {
  state.close();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  cleanup();
}

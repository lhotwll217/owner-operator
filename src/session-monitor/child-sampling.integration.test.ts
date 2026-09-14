import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { State } from "../state/state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";
import { sampleEnrichment } from "./scan";

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
      { type: "session_meta", payload: { id, cwd: dir, source: "cli" } },
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
    if (id.startsWith("completed")) state.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: "Complete", error: null });
  }
  const candidate = state.listEnrichmentCandidates().find(({ id }) => id === "parent")!;
  const sample = await sampleEnrichment(candidate);
  console.log(JSON.stringify({ chars: sample.length, headers: (sample.match(/Delegated child /g) ?? []).length, olderActivePresent: sample.includes("older-running CURRENT_WORK_SENTINEL") }));
  assert.match(sample, /older-running CURRENT_WORK_SENTINEL/, "older active work survives newer terminal siblings");
  assert.match(sample, /older-pending CURRENT_WORK_SENTINEL/, "multiple active children share the bounded context");
  assert.ok(sample.indexOf("Delegated child older-running") < sample.indexOf("Delegated child completed"));
  assert.ok(sample.length <= 48_000, "parent, children, headers and omission notice fit the context bound");
  assert.match(sample, /terminal child transcripts omitted.*context limit/i, "omitted evidence is explicitly identified as incomplete");
  console.log("ok - active child sampling survives terminal history within the context bound");
} finally {
  state.close();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  cleanup();
}

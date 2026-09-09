import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRunHarness, AgentRunStatus, markOnboarded } from "@owner-operator/core";
import { State } from "../state/state";
import { SessionMonitor } from "./monitor";
import { tempOoHome } from "../gateway/test/helpers";

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "oo-census-"));
process.env.HOME = home;
const { dir, cleanup } = tempOoHome("oo-reconciliation");
markOnboarded(dir, { via: "test" });
const state = new State(join(dir, "state.db"));
const monitor = new SessionMonitor(state);
const at = new Date(Date.now() - 5 * 86_400_000).toISOString();
const project = join(home, "project");
function transcript(file: string, records: unknown[]) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  utimesSync(file, new Date(at), new Date(at));
}
try {
  for (let i = 0; i < 55; i++) {
    transcript(join(home, ".codex", "sessions", `real-${i}.jsonl`), [
      { type: "session_meta", payload: { id: `real-${i}`, cwd: project, source: "cli" } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ text: "Investigate the unresolved bug" }] } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", content: [{ text: "Which behavior should the feature preserve?" }] } },
    ]);
  }
  for (const entrypoint of ["cli", "sdk-ts"]) {
    transcript(join(home, ".claude", "projects", "project", `${entrypoint}.jsonl`), [
      { type: "user", entrypoint, sessionId: entrypoint, cwd: project, timestamp: at, message: { content: "Review the real change" } },
      { type: "assistant", sessionId: entrypoint, timestamp: at, message: { content: "The review needs a product decision.", stop_reason: "end_turn" } },
    ]);
  }
  transcript(join(home, ".claude", "projects", "project", "cli", "subagents", "helper.jsonl"), [
    { type: "user", sessionId: "cli", cwd: project, timestamp: at, message: { content: "Helper task" } },
    { type: "user", sessionId: "cli", cwd: project, timestamp: at, message: { content: "More helper work" } },
  ]);
  const run = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "Review the real change", cwd: project, parentThreadId: "real-0", childSessionId: "sdk-ts", depth: 1, timeoutSeconds: 60 });
  state.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: "The review needs a product decision.", error: null });
  transcript(join(home, ".codex", "sessions", "guardian.jsonl"), [
    { type: "session_meta", payload: { id: "guardian", cwd: project, source: { subagent: { other: "guardian" } } } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ text: "Assess this command" }] } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", content: [{ text: '{"outcome":"allow"}' }] } },
  ]);
  const rows = await monitor.poll();
  assert.equal(rows.length, 57, "the default monitor discovers old real work beyond 50 rows and both Claude transports");
  assert.ok(rows.some((row) => row.id === "cli"));
  assert.ok(rows.some((row) => row.id === "sdk-ts"));
  assert.equal(rows.find((row) => row.id === "sdk-ts")?.parentThreadId, "real-0", "a formerly missed SDK session joins its existing delegated-run parent");
  assert.equal(rows.find((row) => row.id === "cli")?.topic, "Review the real change", "a richer native helper cannot replace its parent observation");
  assert.ok(!rows.some((row) => row.id === "guardian"), "explicit guardian provenance is not independent owner work");
  assert.equal(state.listEnrichmentCandidates().length, 57, "unknown idle work remains eligible for its first successful enrichment");
  console.log("ok - actual scanner to monitor to SQLite to current projection, 57 real sessions");
} finally {
  monitor.stop();
  state.close();
  cleanup();
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

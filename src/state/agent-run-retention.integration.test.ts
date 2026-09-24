// Integration: the owner's `agentRunEventLogMaxBytes` setting reaches the event log through
// State, and an unusable value is reported and falls back to the default.
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness } from "@owner-operator/core";
import { State } from "./state";

const ooHome = mkdtempSync(join(tmpdir(), "oo-retention-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = ooHome;
const fill = (state: State): number => {
  const run = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "t", cwd: "/tmp", depth: 1, timeoutSeconds: 60 });
  state.claimNextPendingAgentRun(3);
  for (let index = 0; index < 50; index++) state.appendAgentRunEvent(run.id, { type: "text_delta", text: "x".repeat(100) });
  return state.agentRunEvents(run.id).length;
};

try {
  writeFileSync(join(ooHome, "settings.json"), JSON.stringify({ agentRunEventLogMaxBytes: 1_000 }));
  const bounded = new State(join(ooHome, "bounded.db"));
  const kept = fill(bounded);
  assert.ok(kept > 0 && kept < 10, `the owner's 1000-byte budget keeps only the newest events (kept ${kept})`);
  bounded.close();

  writeFileSync(join(ooHome, "settings.json"), JSON.stringify({ agentRunEventLogMaxBytes: "lots" }));
  const writes: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let fallback: State;
  try {
    fallback = new State(join(ooHome, "fallback.db"));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(fill(fallback), 50, "a rejected setting falls back to the default budget");
  assert.match(writes.join(""), /"event":"setting-rejected".*"setting":"agentRunEventLogMaxBytes".*"value":"lots"/);
  fallback.close();
} finally {
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — event-log retention follows the owner's setting through State; bad values are reported and fall back\n");

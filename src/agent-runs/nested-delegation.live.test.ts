import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, isTerminalAgentRunStatus, type AgentRunLaunchResult } from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

if (process.env.OO_RUN_LIVE_NESTED_DELEGATION !== "1") {
  process.stdout.write("skip - set OO_RUN_LIVE_NESTED_DELEGATION=1 for isolated Codex parent proof\n");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "oo-nested-delegation-live-"));
const previousHome = process.env.OO_HOME;
const previousPath = process.env.PATH;
process.env.OO_HOME = join(root, "oo");
process.env.PATH = `${repoRoot}:${previousPath ?? ""}`;
const { startDaemon } = await import("../daemon/runtime");
const { createAcpLauncher } = await import("./acp-launcher");
const realLauncher = createAcpLauncher();
let releaseChild!: () => void;
const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
const token = "NESTED_CHILD_RESULT_189";
const daemon = await startDaemon({
  port: 0, watch: false, enableEnrichment: false,
  monitor: { scan: async () => [], intervalMs: 60_000 },
  scheduler: { tickMs: 60_000 },
  agentRuns: {
    launcher: async (request): Promise<AgentRunLaunchResult> => {
      if (request.run.model !== "fixture-child") return realLauncher(request);
      await childGate;
      return { status: AgentRunStatus.Completed, resultText: token, error: null };
    },
    tickMs: 20,
  },
});
const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};
try {
  const parent = daemon.agentRuns.launch({
    harness: AgentRunHarness.Codex, model: "gpt-6-sol", effort: "low",
    cwd: repoRoot, timeoutSeconds: 180,
    task: `Use the shell tool to launch one controlled OO child with \`OO_AGENT=1 ${join(repoRoot, "oo")} runs delegate --harness codex `
      + "--model fixture-child --json --from-session <your exact session id> "
      + "\"FIXTURE CHILD: produce result\"`. Substitute the exact session id in your appended instruction. "
      + "Do not wait for the child. Report `PENDING <child run id>` and the remaining work. Owner Operator will continue your saved conversation when the child completes.",
  });
  const child = await waitFor(() => daemon.state.listAgentRuns()
    .find((run) => run.parentThreadId === daemon.state.agentRunById(parent.id)?.childSessionId
      && run.model === "fixture-child"), "nested child row");
  const firstTurn = await waitFor(() => {
    const run = daemon.state.agentRunById(parent.id);
    return run && isTerminalAgentRunStatus(run.status) ? run : undefined;
  }, "parent handoff turn");
  assert.equal(firstTurn.status, AgentRunStatus.Completed, firstTurn.error ?? "");
  assert.equal(child.parentThreadId, firstTurn.childSessionId);
  assert.equal(child.depth, 2);
  assert.match(firstTurn.resultTail ?? "", new RegExp(child.id));
  assert.match(firstTurn.resultTail ?? "", /PENDING/);
  assert.ok(!isTerminalAgentRunStatus(daemon.state.agentRunById(child.id)!.status));
  releaseChild();
  const finishedChild = await waitFor(() => {
    const run = daemon.state.agentRunById(child.id);
    return run && isTerminalAgentRunStatus(run.status) ? run : undefined;
  }, "controlled child completion");
  assert.equal(finishedChild.status, AgentRunStatus.Completed);
  const followUp = await waitFor(() => daemon.state.listAgentRuns()
    .find((run) => run.resumeOfRunId === parent.id), "automatic parent follow-up");
  const finalTurn = await waitFor(() => {
    const run = daemon.state.agentRunById(followUp.id);
    return run && isTerminalAgentRunStatus(run.status) ? run : undefined;
  }, "parent continuation");
  assert.equal(finalTurn.status, AgentRunStatus.Completed, finalTurn.error ?? "");
  assert.equal(finalTurn.childSessionId, firstTurn.childSessionId);
  assert.equal(finalTurn.acpxRecordId, firstTurn.acpxRecordId);
  assert.equal(finalTurn.resumeOfRunId, parent.id);
  assert.match(finalTurn.resultTail ?? "", new RegExp(token));
  process.stdout.write(JSON.stringify({ parentRunId: parent.id, childRunId: child.id,
    resumedRunId: followUp.id, parentChildSessionId: finalTurn.childSessionId,
    childDepth: child.depth, result: finalTurn.resultTail?.trim() }) + "\n");
} finally {
  releaseChild();
  await daemon.close();
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
}

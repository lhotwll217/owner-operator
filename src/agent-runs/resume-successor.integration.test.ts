import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpRuntime } from "acpx/runtime";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";
import { createAcpLauncher } from "./acp-launcher";
import { deriveParentAgentStateWithEnvironment } from "./agent-state-projection";

for (const phase of ["queued", "loading"] as const) {
  const dir = mkdtempSync(join(tmpdir(), `oo-resume-successor-${phase}-`));
  const previousHome = process.env.OO_HOME;
  process.env.OO_HOME = dir;
  const state = new State(join(dir, "state.db"));
  const records = new Map<string, { acpxRecordId: string; acpSessionId: string; agentSessionId: string; cwd: string }>();
  let holdLoad = false;
  let loading!: () => void;
  const loadReached = new Promise<void>((resolve) => { loading = resolve; });
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  let blockerStarted!: () => void;
  const blocking = new Promise<void>((resolve) => { blockerStarted = resolve; });
  const runtime = {
    ensureSession: async ({ sessionKey, resumeSessionId }: { sessionKey: string; resumeSessionId?: string }) => {
      if (resumeSessionId) {
        assert.equal(resumeSessionId, records.get(sessionKey)?.acpSessionId);
        if (holdLoad) { loading(); await loadGate; }
      } else {
        records.set(sessionKey, { acpxRecordId: sessionKey, acpSessionId: `acp-${sessionKey}`,
          agentSessionId: `child-${sessionKey}`, cwd: dir });
      }
      const record = records.get(sessionKey)!;
      return { sessionKey, acpxRecordId: record.acpxRecordId,
        agentSessionId: record.agentSessionId, backendSessionId: record.acpSessionId };
    },
    getStatus: async () => ({ models: { currentModelId: "test-model" }, details: { configOptions: [] } }),
    close: async () => undefined,
    startTurn: ({ text, signal }: { text: string; signal: AbortSignal }) => {
      const promptStarted = signal.aborted
        ? Promise.reject(new Error("ACP turn cancelled before prompt submission.")) : Promise.resolve();
      void promptStarted.catch(() => {});
      const result = signal.aborted ? Promise.resolve({ status: "cancelled" })
        : text.startsWith("block queue") ? new Promise<{ status: string }>((resolve) => {
            signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
            blockerStarted();
          }) : Promise.resolve({ status: "completed" });
      return { promptStarted, result, events: (async function* () { await result; yield* []; })() };
    },
  } as unknown as AcpRuntime;
  const executor = new AgentRunExecutor(state, {
    maxConcurrent: 1,
    launcher: createAcpLauncher({ leasedRuntimeFactory: () => ({
      runtime, sessionStore: { load: async (id: string) => records.get(id) } as never,
      leaseId: "fixture", release: () => undefined, processTreePids: async () => [], terminate: async () => true,
    }) }),
  });
  const launch = (task: string) => executor.launch({ harness: AgentRunHarness.Codex, task, cwd: dir, model: "test-model", effort: null });
  try {
    const original = await executor.wait(launch("establish conversation").id, 5_000);
    assert.equal(original.status, AgentRunStatus.Completed);
    assert.equal(original.promptSubmitted, true);
    const blocker = phase === "queued" ? launch("block queue") : undefined;
    if (blocker) await blocking;
    holdLoad = phase === "loading";
    const successor = executor.resume(original.id, "unsent follow-up");
    if (phase === "loading") await loadReached;
    assert.equal(state.agentRunById(successor.id)?.status,
      phase === "queued" ? AgentRunStatus.Pending : AgentRunStatus.Running);
    const cancellation = executor.cancel(successor.id);
    releaseLoad();
    const cancelled = await cancellation;
    holdLoad = false;
    if (blocker) await executor.cancel(blocker.id);
    assert.equal(cancelled.status, AgentRunStatus.Cancelled);
    assert.equal(cancelled.promptSubmitted, false, "successor never submitted its own prompt");
    assert.equal(cancelled.resumeOfRunId, original.id);
    assert.throws(() => executor.resume(original.id, "branch"), /already been resumed/);
    assert.equal(deriveParentAgentStateWithEnvironment(state.listAgentRuns()).runs
      .find(({ id }) => id === successor.id)?.canResume, true,
    `${phase} cancellation of a resume successor must leave the conversation resumable`);
    const resumed = await executor.wait(executor.resume(successor.id, "continue existing conversation").id, 5_000);
    assert.equal(resumed.status, AgentRunStatus.Completed, resumed.error ?? "successor resumes");
    assert.equal(resumed.resumeOfRunId, successor.id);
    assert.equal(resumed.childSessionId, original.childSessionId);
    assert.equal(resumed.acpxRecordId, original.acpxRecordId);
    assert.equal(resumed.promptSubmitted, true);
    assert.deepEqual(state.agentRunById(successor.id), cancelled);
    assert.deepEqual(state.agentRunById(original.id), original);
    process.stdout.write(`ok - resume successor cancelled while ${phase} continues the same conversation\n`);
  } finally {
    releaseLoad();
    await executor.stop();
    state.close();
    if (previousHome === undefined) delete process.env.OO_HOME;
    else process.env.OO_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

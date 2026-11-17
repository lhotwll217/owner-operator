// Every delegation names where it came from. Through `oo runs delegate` and the daemon: a parent
// the daemon knows (an indexed thread, a run's child session, or a transcript only the store
// holds) nests the run under it; --origin makes an outside caller's run its own root row; a
// parent that matches nothing, with no --origin, is rejected and creates no run.
import assert from "node:assert";
import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  type AgentRun,
  AgentRunHarness,
  approveDelegatedBaseline,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
} from "@owner-operator/core";
import type { AgentRunLauncher } from "../agent-runs/executor";
import { connectGateway } from "../gateway/client";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { CALLER_SESSION_ENV } from "../shared/caller-session";
import { repoRoot } from "../shared/repo-root";
import { startDaemon } from "./runtime";

const { dir: ooHome, cleanup } = tempOoHome("oo-delegation-parent-e2e");
approveDelegatedBaseline(AgentRunHarness.Codex, { model: "test-codex", effort: "high" }, ooHome);

const launcher: AgentRunLauncher = (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> =>
  new Promise((_resolve, reject) => {
    request.onActivity({ activity: "child started", childSessionId: `child-of-${request.run.id}`, acpxRecordId: `acpx-${request.run.id}` });
    const abort = (): void => reject(request.signal.reason ?? new Error("aborted"));
    if (request.signal.aborted) return abort();
    request.signal.addEventListener("abort", abort, { once: true });
  });
launcher.reapOrphans = async () => undefined;

const daemon = await startDaemon({
  port: 0,
  watch: false,
  enableEnrichment: false,
  monitor: {
    scan: async () => [fakeScanRow({ id: "operator-thread", source: "pi", app: "Owner Operator", lastMessageAt: new Date().toISOString() })],
    intervalMs: 60_000,
  },
  scheduler: { tickMs: 60_000 },
  agentRuns: { launcher, tickMs: 20, maxConcurrent: 5, logger: () => undefined },
  transcriptExists: async (id) => id === "scheduled-operator",
});

const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => ![...CALLER_SESSION_ENV, "OO_CURRENT_SESSION_ID"].includes(name)));
const oo = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
  execFile(join(repoRoot, "oo"), ["runs", "delegate", "--json", "--harness", AgentRunHarness.Codex, "--cwd", ooHome, ...args], {
    env: { ...env, OO_AGENT: "1" },
    encoding: "utf8",
  }, (error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
});
const delegate = async (args: string[]): Promise<AgentRun> => {
  const result = await oo(args);
  assert.equal(result.code, 0, `delegate ${args.join(" ")} succeeds: ${result.stderr}`);
  return JSON.parse(result.stdout) as AgentRun;
};

const gateway = (await connectGateway())!;
try {
  await waitFor(() => daemon.state.knowsSession("operator-thread"), 1_000, "indexed Operator thread");

  const nested = await delegate(["--from-session", "operator-thread", "nest under the Operator"]);
  assert.equal(nested.parentThreadId, "operator-thread", "a known parent records the run as its child");
  assert.equal(nested.origin, null, "a local delegation carries no origin");

  const scheduled = await delegate(["--from-session", "scheduled-operator", "nest under an unindexed session"]);
  assert.equal(scheduled.parentThreadId, "scheduled-operator",
    "a parent found only in the transcript store, such as a scheduled Operator turn, is local");

  const childSession = `child-of-${nested.id}`;
  await waitFor(() => daemon.state.knowsSession(childSession), 3_000, "first child's session id");
  const grandchild = await delegate(["--from-session", childSession, "nest under a delegated child"]);
  assert.equal(grandchild.parentThreadId, childSession, "a delegated child's session is a local parent");
  assert.equal(grandchild.depth, 2, "a grandchild sits one level deeper");

  const before = (await gateway.listAgentRuns()).length;
  const rejected = await oo(["--from-session", "ghost-session", "no origin, unknown parent"]);
  assert.equal(rejected.code, 1, "an unknown parent without --origin fails");
  assert.match(rejected.stderr, /parent session ghost-session matches no session on this Mac/, "the error names the unknown parent");
  assert.match(rejected.stderr, /outside caller \(such as grok-bot\) passes --origin <name>/, "the error offers --origin to outside callers");
  assert.match(rejected.stderr, /local agent passes --from-session <id> with its real session id/, "the error offers --from-session to local agents");
  assert.equal((await gateway.listAgentRuns()).length, before, "a rejected delegation creates no run");

  const outside = await delegate(["--from-session", "ghost-session", "--origin", "grok-bot", "outside caller task"]);
  assert.equal(outside.origin, "grok-bot", "--origin is recorded on the run");
  const row = (await gateway.sessionState()).find(({ origin }) => origin === "grok-bot");
  assert.ok(row, "the outside caller's run has its own session row");
  assert.equal(row.parentThreadId, null, "an origin run is a top-level row");

  process.stdout.write("ok — delegation nests under a local parent, roots an origin run, and rejects an unknown parent\n");
} finally {
  gateway.close();
  await daemon.close();
  cleanup();
}

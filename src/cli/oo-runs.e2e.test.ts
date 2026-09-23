// e2e: `oo runs` against a hermetic daemon with a scripted launcher. The daemon owns the child:
// the CLI streams the stored event log, a killed CLI leaves the run running, and reattaching
// replays the log from the start to its terminal record.
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunStatus, type AgentRun, type AgentRunLaunchRequest, type DaemonInfo } from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

const ooHome = mkdtempSync(join(tmpdir(), "oo-runs-e2e-"));
process.env.OO_HOME = ooHome;
for (const key of ["OO_FROM_SESSION", "CODEX_THREAD_ID"]) delete process.env[key];
let daemon: Awaited<ReturnType<typeof import("../daemon/runtime")["startDaemon"]>> | null = null;

const launched: AgentRunLaunchRequest[] = [];
const held = new Map<string, () => void>();
const launcher = async (request: AgentRunLaunchRequest) => {
  launched.push(request);
  const childSessionId = `child-${request.run.id}`;
  request.onActivity({ childSessionId, acpxRecordId: `acpx-${request.run.id}` });
  request.onActivity({ harnessIdentity: { observed: true, model: request.run.model ?? "harness-picked", effort: "high" } });
  request.onEvent?.({ type: "text_delta", stream: "thought", text: "planning" });
  request.onEvent?.({ type: "tool_call", text: "read", title: "Read README", toolCallId: "t1", status: "pending" });
  request.onEvent?.({ type: "tool_call", text: "read", title: "Read README", toolCallId: "t1", status: "completed" });
  request.onEvent?.({ type: "text_delta", stream: "output", text: "OO_STREAM" });
  if (request.run.task.includes("HOLD")) await new Promise<void>((release) => held.set(request.run.id, release));
  request.onEvent?.({ type: "text_delta", stream: "output", text: "_OK" });
  return { status: AgentRunStatus.Completed as const, resultText: "OO_STREAM_OK", error: null, childSessionId, acpxRecordId: `acpx-${request.run.id}` };
};

const spawnOo = (args: readonly string[], env: NodeJS.ProcessEnv = {}): ChildProcess & { out: { stdout: string; stderr: string } } => {
  const child = spawn(join(repoRoot, "oo"), args, { cwd: repoRoot, env: { ...process.env, ...env } }) as ChildProcess & { out: { stdout: string; stderr: string } };
  child.out = { stdout: "", stderr: "" };
  child.stdout!.setEncoding("utf8").on("data", (chunk) => { child.out.stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk) => { child.out.stderr += chunk; });
  return child;
};
const runOo = async (args: readonly string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawnOo(args, env);
  const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { status, ...child.out };
};
const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const ndjson = (stdout: string): Array<Record<string, unknown>> => stdout.trim().split("\n").map((line) => JSON.parse(line));
const runIdFrom = (stderr: string): string => /\[run ([0-9a-f-]{36}) /.exec(stderr)?.[1] ?? "";

try {
  const { startDaemon } = await import("../daemon/runtime");
  daemon = await startDaemon({
    port: 0,
    dbPath: join(ooHome, "state.db"),
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
    agentRuns: { launcher, tickMs: 50 },
  });
  const state = daemon.state;

  // GET /events stays an invalidation stream: record it for the whole test.
  const info = JSON.parse(readFileSync(join(ooHome, "daemon.json"), "utf8")) as DaemonInfo;
  const invalidations: string[] = [];
  const eventsAbort = new AbortController();
  void fetch(`http://127.0.0.1:${info.port}/events`, {
    headers: { authorization: `Bearer ${info.authToken}` },
    signal: eventsAbort.signal,
  }).then(async (response) => {
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) invalidations.push(decoder.decode(chunk));
  }).catch(() => undefined);

  // delegate --json: NDJSON events as they happen, then the result line; exit 0 on completed.
  const delegated = await runOo(["runs", "delegate", "--harness", "claude-code", "reply OO_STREAM_OK", "--json"]);
  assert.equal(delegated.status, 0, delegated.stderr);
  const id = runIdFrom(delegated.stderr);
  const lines = ndjson(delegated.stdout);
  assert.deepEqual(lines, state.agentRunEvents(id).map(({ record }) => record), "stdout is exactly the stored log");
  assert.deepEqual(lines.at(-1), { type: "result", runId: id, status: "completed" });
  assert.deepEqual(lines.slice(0, -1).map((line) => line.type), ["text_delta", "tool_call", "tool_call", "text_delta", "text_delta"]);

  // Unpinned with no approved baseline: launches, and records what the harness confirmed.
  const row = state.agentRunById(id)!;
  assert.equal(row.model, null, "no pin and no baseline reaches the harness unpinned");
  assert.deepEqual(row.harnessIdentity, { observed: true, model: "harness-picked", effort: "high" });
  assert.equal(row.parentThreadId, null, "no caller identity → no parent");

  // Text rendering: agent text and one line per tool call; thought stays out.
  const text = await runOo(["runs", "logs", id]);
  assert.equal(text.stdout, "→ Read README\nOO_STREAM_OK\n");
  assert.match(text.stderr, /\[run .* completed\]/);

  // Lineage: --from-session, then env, then none; the depth guard still applies.
  const flagged = await runOo(["runs", "delegate", "--harness", "codex", "t", "--no-wait", "--json", "--from-session", "parent-flag"], { OO_FROM_SESSION: "parent-env" });
  const flaggedRow = JSON.parse(flagged.stdout) as AgentRun;
  assert.equal(flaggedRow.status, AgentRunStatus.Pending, "--no-wait returns the pending row");
  assert.equal(flaggedRow.parentThreadId, "parent-flag", "--from-session wins");
  const fromEnv = JSON.parse((await runOo(["runs", "delegate", "--harness", "codex", "t", "--no-wait", "--json"], { CODEX_THREAD_ID: "parent-codex" })).stdout) as AgentRun;
  assert.equal(fromEnv.parentThreadId, "parent-codex", "the harness env names the parent");
  const nested = await runOo(["runs", "delegate", "--harness", "codex", "t", "--from-session", `child-${id}`]);
  assert.equal(nested.status, 1, "a delegated child cannot delegate");
  assert.match(nested.stderr, /delegation depth 2 exceeds the cap of 1/);

  // Kill the CLI mid-stream: the run keeps running; logs --follow replays from the start.
  const streaming = spawnOo(["runs", "delegate", "--harness", "claude-code", "HOLD then reply", "--json"]);
  const heldId = await waitFor(() => runIdFrom(streaming.out.stderr) || undefined, "run id");
  await waitFor(() => streaming.out.stdout.includes("OO_STREAM") ? true : undefined, "first streamed text");
  streaming.kill("SIGKILL");
  await new Promise((resolve) => streaming.once("close", resolve));
  assert.equal(state.agentRunById(heldId)!.status, AgentRunStatus.Running, "killing the CLI leaves the run running");
  const partial = await runOo(["runs", "logs", heldId, "--json"]);
  assert.equal(partial.status, 0, "logs without --follow prints the log so far");
  assert.equal(ndjson(partial.stdout).at(-1)?.type, "text_delta", "no terminal record yet");
  const follower = spawnOo(["runs", "logs", "--follow", heldId, "--json"]);
  await waitFor(() => follower.out.stdout.split("\n").length > 4 ? true : undefined, "replayed log");
  held.get(heldId)!();
  const followed = await new Promise<number | null>((resolve) => follower.once("close", resolve));
  assert.equal(followed, 0, "reattached follow exits 0 on completed");
  assert.deepEqual(ndjson(follower.out.stdout), state.agentRunEvents(heldId).map(({ record }) => record),
    "the tail route serves every stored event in order, from the start to the terminal record");
  assert.equal(ndjson(follower.out.stdout).at(-1)?.status, "completed");

  // Durable-row verbs return the route's row.
  assert.deepEqual(JSON.parse((await runOo(["runs", "get", heldId, "--json"])).stdout), state.agentRunById(heldId));
  const listed = JSON.parse((await runOo(["runs", "list", "--json"])).stdout) as AgentRun[];
  assert.deepEqual(listed, state.listAgentRuns(), "list returns GET /agent-runs");
  const resume = await runOo(["runs", "resume", heldId, "follow up", "--json"]);
  assert.equal(resume.status, 0, resume.stderr);
  const resumed = JSON.parse(resume.stdout) as AgentRun;
  assert.equal(resumed.resumeOfRunId, heldId);
  const cancelled = await runOo(["runs", "delegate", "--harness", "codex", "HOLD cancel me", "--no-wait", "--json"]);
  const cancelId = (JSON.parse(cancelled.stdout) as AgentRun).id;
  await waitFor(() => held.get(cancelId), "cancel target running");
  const cancelRow = JSON.parse((await runOo(["runs", "cancel", cancelId, "--json"])).stdout) as AgentRun;
  held.get(cancelId)!();
  assert.equal((await waitFor(() => {
    const current = state.agentRunById(cancelId)!;
    return current.status === AgentRunStatus.Running ? undefined : current;
  }, "cancelled")).status, AgentRunStatus.Cancelled, `cancel finalizes the run (returned ${cancelRow.status})`);
  // A log far larger than the pipe buffer, read only after a pause, arrives whole with its
  // terminal record: the CLI waits on backpressure and drains stdout before exiting.
  const big = state.createAgentRun({ harness: "claude-code" as never, task: "HOLD big log", cwd: repoRoot, depth: 1, timeoutSeconds: 60 });
  await waitFor(() => held.get(big.id), "big run running");
  for (let index = 0; index < 400; index++) {
    assert.notEqual(state.appendAgentRunEvent(big.id, { type: "text_delta", stream: "output", text: "y".repeat(4_000) }), null);
  }
  held.get(big.id)!();
  await waitFor(() => state.agentRunById(big.id)!.status === AgentRunStatus.Running ? undefined : true, "big run finished");
  const slow = spawnOo(["runs", "logs", big.id, "--json"]);
  const slowClosed = new Promise<number | null>((resolve) => slow.once("close", resolve));
  slow.stdout!.pause();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  slow.stdout!.resume();
  const slowStatus = await slowClosed;
  const slowLines = ndjson(slow.out.stdout);
  assert.equal(slowStatus, 0, slow.out.stderr);
  assert.equal(slowLines.length, state.agentRunEvents(big.id).length, "every stored record reaches a slow reader");
  assert.ok(slowLines.length > 400);
  assert.equal(slowLines.at(-1)?.type, "result", "the terminal record arrives");

  const missing = await runOo(["runs", "logs", "no-such-run", "--json"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stderr), { status: 404, error: "no such agent run" });

  eventsAbort.abort();
  const frames = invalidations.join("").split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  assert.ok(frames.length > 0, "the invalidation stream stayed live");
  assert.ok(frames.every((frame) => Object.keys(frame).join() === "kind"), "GET /events still carries only invalidation kinds");
} finally {
  for (const release of held.values()) release();
  await daemon?.close();
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — oo runs: NDJSON stream to the terminal record, detach/reattach replay, lineage, harness choice, row verbs\n");

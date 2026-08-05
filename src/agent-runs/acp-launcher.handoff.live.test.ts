// Opt-in paid/live experiment: can a human take a turn on a delegated child's native session
// (via the harness CLI, standing in for the harness TUI) and have a subsequent ACP resume see
// that turn? Decides between the "sequential handoff" design and the "flagged runs launch
// native" fallback. Never discovered by npm test; run with OO_RUN_LIVE_HANDOFF_TEST=1.
//
// Flow: ACP run completes → daemon stops (no warm child) → `claude -p --resume <id>` appends a
// marker turn as a second native writer → daemon restarts → ACP resume replays a task that asks
// whether the marker is in-context. Prints a `verdict:` line either way; only plumbing failures
// exit non-zero. Also reports whether the CLI resume forked the session id, since a fork strands
// OO's stored childSessionId on the pre-handoff branch.
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRunHarness,
  AgentRunStatus,
  isTerminalAgentRunStatus,
  type AgentRun,
  type DaemonInfo,
} from "@owner-operator/core";

if (process.env.OO_ACP_LIVE_DAEMON_WORKER === "1") {
  const { startDaemon: startRuntimeDaemon } = await import("../daemon/runtime");
  const running = await startRuntimeDaemon({
    port: 0,
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
  });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await running.close();
  process.exit(0);
}

if (process.env.OO_RUN_LIVE_HANDOFF_TEST !== "1") {
  process.stdout.write("skip — set OO_RUN_LIVE_HANDOFF_TEST=1 to run the paid handoff experiment\n");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const root = process.cwd();
const liveTestPath = fileURLToPath(import.meta.url);
const ooHome = mkdtempSync(join(tmpdir(), "oo-handoff-live-"));
const daemonInfoPath = join(ooHome, "daemon.json");
const marker = `OO_HANDOFF_MARKER_${process.pid}_${Date.now()}`;
let daemon: ChildProcess | undefined;
let daemonError = "";

const waitFor = async <T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = 60_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${daemonError ? `: ${daemonError}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const readInfo = (): DaemonInfo | undefined => {
  try {
    return JSON.parse(readFileSync(daemonInfoPath, "utf8")) as DaemonInfo;
  } catch {
    return;
  }
};

const startDaemon = async (): Promise<ChildProcess> => {
  daemonError = "";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", liveTestPath],
    {
      cwd: root,
      env: { ...process.env, OO_HOME: ooHome, OO_ACP_LIVE_DAEMON_WORKER: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.on("data", (chunk) => {
    daemonError = `${daemonError}${String(chunk)}`.slice(-4_000);
  });
  await waitFor(async () => {
    const info = readInfo();
    if (!info || info.pid !== child.pid) return;
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
        headers: { authorization: `Bearer ${info.authToken}` },
      });
      return response.ok ? child : undefined;
    } catch {
      return;
    }
  }, "daemon readiness");
  return child;
};

const request = async <T>(path: string, body?: unknown): Promise<T> => {
  const info = readInfo();
  if (!info) throw new Error("daemon discovery file is unavailable");
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${info.authToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`gateway ${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
};

const stopDaemon = async (signal: NodeJS.Signals): Promise<void> => {
  const child = daemon;
  daemon = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null ? true : undefined,
    `daemon exit after ${signal}`,
    15_000,
  );
};

const awaitTerminal = (id: string, label: string): Promise<AgentRun> =>
  waitFor(async () => {
    const row = await request<AgentRun>(`/agent-runs/${id}`);
    return isTerminalAgentRunStatus(row.status) ? row : undefined;
  }, label, 300_000);

try {
  daemon = await startDaemon();
  // resume() replays the run's original task on the persisted child session, so the task itself
  // is the probe: round one answers NOT_SEEN, and the post-handoff resume answers SEEN iff the
  // CLI-appended turn made it into the child's context.
  const launched = await request<AgentRun>("/agent-runs", {
    harness: AgentRunHarness.ClaudeCode,
    task: `If any earlier message in this conversation contains the token ${marker}, reply with exactly OO_HANDOFF_SEEN. Otherwise reply with exactly OO_HANDOFF_NOT_SEEN. Do not use tools.`,
    cwd: root,
    model: process.env.OO_ACP_LIVE_MODEL?.trim() || "sonnet",
    timeoutSeconds: 300,
  });
  const first = await awaitTerminal(launched.id, "first ACP turn");
  assert.equal(first.status, AgentRunStatus.Completed, `first turn failed: ${first.error}`);
  assert.match(first.resultTail ?? "", /OO_HANDOFF_NOT_SEEN/, "round one must not see the marker");
  const childSessionId = first.childSessionId;
  assert.ok(childSessionId, "the ACP handshake publishes the harness session identity");

  // Stop the daemon so no warm child process can mask the on-disk question, then take the
  // "human" turn as a second native writer. `claude -p --resume` stands in for the TUI —
  // same session store, same append path, scriptable.
  await stopDaemon("SIGTERM");
  const { stdout } = await execFileAsync(
    "claude",
    [
      "-p",
      "--resume",
      childSessionId,
      "--output-format",
      "json",
      "--model",
      process.env.OO_ACP_LIVE_MODEL?.trim() || "sonnet",
      `Please acknowledge this token so it is part of this conversation: ${marker}. Reply with just the token. Do not use tools.`,
    ],
    { cwd: root, timeout: 300_000 },
  );
  const cliResult = JSON.parse(stdout) as { session_id?: string; result?: string };
  assert.match(cliResult.result ?? "", new RegExp(marker), "the CLI turn must echo the marker");
  const forked = Boolean(cliResult.session_id) && cliResult.session_id !== childSessionId;
  process.stdout.write(
    forked
      ? `cli resume FORKED the session: ${childSessionId} -> ${cliResult.session_id}\n`
      : `cli resume kept the session id: ${childSessionId}\n`,
  );

  daemon = await startDaemon();
  const reconciled = await request<AgentRun>(`/agent-runs/${launched.id}`);
  assert.ok(
    ["completed", "interrupted"].includes(reconciled.status),
    `run must stay resumable after restart, got ${reconciled.status}`,
  );
  const resumed = await request<AgentRun>(`/agent-runs/${launched.id}/resume`, {});
  const second = await awaitTerminal(resumed.id, "post-handoff ACP resume");
  assert.equal(second.status, AgentRunStatus.Completed, `resumed turn failed: ${second.error}`);
  assert.equal(second.childSessionId, childSessionId, "OO's stored child identity must survive the handoff");

  const seen = /OO_HANDOFF_SEEN/.test(second.resultTail ?? "");
  process.stdout.write(
    seen
      ? "verdict: HANDOFF WORKS — the ACP resume sees the CLI-appended turn; build the who-holds-the-pen gate\n"
      : `verdict: HANDOFF BROKEN — the ACP resume did not see the CLI turn (${forked ? "session id forked; OO's identity points at the pre-handoff branch" : "id stable, so the adapter did not reload the appended transcript"}); fall back to launching flagged runs native\n`,
  );
} finally {
  await stopDaemon("SIGTERM").catch(() => {});
  rmSync(ooHome, { recursive: true, force: true });
}

// Opt-in paid/live acceptance for issue #69. It drives the pinned acpx runtime through a real
// Claude Code child, hard-kills the daemon mid-turn, then verifies durable interruption and
// same-session resume. Never discovered by npm test; run with OO_RUN_LIVE_ACP_TEST=1.
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
  isTerminalAgentRunStatus,
  type AgentRun,
  type DaemonInfo,
} from "@owner-operator/core";

if (process.env.OO_RUN_LIVE_ACP_TEST !== "1") {
  process.stdout.write("skip — set OO_RUN_LIVE_ACP_TEST=1 to run the paid Claude ACP acceptance\n");
  process.exit(0);
}

const root = process.cwd();
const ooHome = mkdtempSync(join(tmpdir(), "oo-acp-live-"));
const daemonInfoPath = join(ooHome, "daemon.json");
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
    ["--import", "tsx", join(root, "src/cli/oo.ts"), "daemon"],
    {
      cwd: root,
      env: { ...process.env, OO_HOME: ooHome },
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

try {
  daemon = await startDaemon();
  const launched = await request<AgentRun>("/agent-runs", {
    harness: AgentRunHarness.ClaudeCode,
    task: "Reply with exactly OO_ACP_LIVE_OK. Do not use tools.",
    cwd: root,
    timeoutSeconds: 300,
  });
  const running = await waitFor(async () => {
    const row = await request<AgentRun>(`/agent-runs/${launched.id}`);
    return row.status === AgentRunStatus.Running && row.childSessionId ? row : undefined;
  }, "real Claude child identity", 120_000);

  const originalChildSessionId = running.childSessionId;
  assert.ok(originalChildSessionId, "the real ACP handshake publishes the harness session identity");
  await stopDaemon("SIGKILL");

  daemon = await startDaemon();
  const interrupted = await request<AgentRun>(`/agent-runs/${launched.id}`);
  assert.equal(interrupted.status, AgentRunStatus.Interrupted);
  assert.match(interrupted.error ?? "", /daemon restarted/);

  const resumed = await request<AgentRun>(`/agent-runs/${launched.id}/resume`, {});
  const finished = await waitFor(async () => {
    const row = await request<AgentRun>(`/agent-runs/${resumed.id}`);
    return isTerminalAgentRunStatus(row.status) ? row : undefined;
  }, "resumed Claude turn", 300_000);
  assert.equal(finished.status, AgentRunStatus.Completed);
  assert.equal(finished.error, null);
  assert.equal(finished.childSessionId, originalChildSessionId, "resume preserves native child identity");
  assert.match(finished.resultTail ?? "", /OO_ACP_LIVE_OK/);

  process.stdout.write("ok — real Claude ACP turn survives daemon kill through interrupted → resume\n");
} finally {
  await stopDaemon("SIGTERM").catch(() => {});
  rmSync(ooHome, { recursive: true, force: true });
}

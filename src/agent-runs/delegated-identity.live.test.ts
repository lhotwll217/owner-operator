// Opt-in paid #128 smoke: one real delegated turn through Gateway/executor/ACP, proving the
// requested exact identity is retained by the existing lifecycle. Excluded from npm test.
// Required: OO_LIVE_IDENTITY_HARNESS, OO_LIVE_IDENTITY_MODEL, OO_LIVE_IDENTITY_EFFORT
// Run: OO_RUN_LIVE_DELEGATED_IDENTITY=1 npm run test:delegated-identity:live
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUN_EFFORTS,
  AgentRunHarness,
  isTerminalAgentRunStatus,
  type AgentRun,
  type AgentRunEffort,
  type DaemonInfo,
} from "@owner-operator/core";

if (process.env.OO_LIVE_IDENTITY_WORKER === "1") {
  const { startDaemon } = await import("../daemon/runtime");
  const daemon = await startDaemon({
    port: 0,
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
  });
  await new Promise<void>((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
  await daemon.close();
  process.exit(0);
}

if (process.env.OO_RUN_LIVE_DELEGATED_IDENTITY !== "1") {
  process.stdout.write("skip — set OO_RUN_LIVE_DELEGATED_IDENTITY=1 and exact identity variables to run the paid smoke\n");
  process.exit(0);
}

const harness = process.env.OO_LIVE_IDENTITY_HARNESS as AgentRunHarness | undefined;
const model = process.env.OO_LIVE_IDENTITY_MODEL?.trim();
const effortText = process.env.OO_LIVE_IDENTITY_EFFORT?.trim();
assert.ok(Object.values(AgentRunHarness).includes(harness!), "set OO_LIVE_IDENTITY_HARNESS to claude-code or codex");
assert.ok(model, "set OO_LIVE_IDENTITY_MODEL to an exact harness model id");
assert.ok(effortText === "null" || AGENT_RUN_EFFORTS.includes(effortText as AgentRunEffort),
  "set OO_LIVE_IDENTITY_EFFORT to null or a supported effort");
const effort = effortText === "null" ? null : effortText as AgentRunEffort;
const ooHome = mkdtempSync(join(tmpdir(), "oo-live-delegated-identity-"));
const daemonPath = join(ooHome, "daemon.json");
const testPath = fileURLToPath(import.meta.url);
let daemon: ChildProcess | undefined;
let stderr = "";

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 300_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function info(): DaemonInfo | undefined {
  try { return JSON.parse(readFileSync(daemonPath, "utf8")) as DaemonInfo; } catch { return; }
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const daemonInfo = info();
  assert.ok(daemonInfo);
  const response = await fetch(`http://127.0.0.1:${daemonInfo.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${daemonInfo.authToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

try {
  daemon = spawn(process.execPath, ["--import", "tsx", testPath], {
    cwd: process.cwd(),
    env: { ...process.env, OO_HOME: ooHome, OO_LIVE_IDENTITY_WORKER: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
  await waitFor(async () => {
    const daemonInfo = info();
    if (!daemonInfo || daemonInfo.pid !== daemon?.pid) return;
    try { return (await request<{ ok: boolean }>("/health")).ok ? true : undefined; } catch { return; }
  }, "daemon readiness", 60_000);
  const requested = { harness, model, effort, task: "Reply with exactly OO_DELEGATED_IDENTITY_OK. Do not use tools.", cwd: process.cwd(), timeoutSeconds: 240 };
  const launched = await request<AgentRun>("/agent-runs", requested);
  assert.deepEqual({ harness: launched.harness, model: launched.model, effort: launched.effort }, { harness, model, effort });
  const finished = await waitFor(async () => {
    const row = await request<AgentRun>(`/agent-runs/${launched.id}`);
    return isTerminalAgentRunStatus(row.status) ? row : undefined;
  }, "real delegated turn");
  assert.deepEqual({ harness: finished.harness, model: finished.model, effort: finished.effort }, { harness, model, effort });
  assert.ok(finished.childSessionId, "lifecycle reports the real child identity");
  assert.match(finished.resultTail ?? "", /OO_DELEGATED_IDENTITY_OK/);
  process.stdout.write(`ok — lifecycle retained ${harness} / ${model} / effort ${String(effort)}\n`);
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGTERM");
    await waitFor(() => daemon?.exitCode !== null || daemon?.signalCode !== null ? true : undefined, "daemon exit", 15_000).catch(() => daemon?.kill("SIGKILL"));
  }
  rmSync(ooHome, { recursive: true, force: true });
}

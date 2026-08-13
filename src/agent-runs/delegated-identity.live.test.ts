// Opt-in paid #128 smoke: one real delegated turn through Gateway/executor/ACP, proving the
// requested exact identity is retained by the existing lifecycle. Excluded from npm test.
// Required: OO_LIVE_IDENTITY_HARNESS, OO_LIVE_IDENTITY_MODEL, OO_LIVE_IDENTITY_EFFORT
// Run: OO_RUN_LIVE_DELEGATED_IDENTITY=1 npm run test:delegated-identity:live
import assert from "node:assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { absoluteTsxLoaderPath } from "../shared/tsx-loader";
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
const credentialSource = process.env.OO_LIVE_IDENTITY_CREDENTIAL_SOURCE?.trim();
const configSource = process.env.OO_LIVE_IDENTITY_CONFIG_SOURCE?.trim();
assert.ok(credentialSource, "set OO_LIVE_IDENTITY_CREDENTIAL_SOURCE to the explicit harness credential file");
assert.ok(configSource, "set OO_LIVE_IDENTITY_CONFIG_SOURCE to the explicit harness config file");
const userHome = mkdtempSync(join(tmpdir(), "oo-live-delegated-identity-"));
const ooHome = join(userHome, "state", ".owner-operator");
const neutralCwd = join(userHome, "neutral-cwd");
const daemonPath = join(ooHome, "daemon.json");
const testPath = fileURLToPath(import.meta.url);
let daemon: ChildProcess | undefined;
let daemonExited: Promise<void> | undefined;
let teardownError: unknown;
let isolatedLeaseIds: string[] = [];
let isolatedProcessPids: number[] = [];

const harnessHome = harness === AgentRunHarness.Codex ? join(userHome, ".codex") : join(userHome, ".claude");
const copiedCredentialPath = join(harnessHome, harness === AgentRunHarness.Codex ? "auth.json" : ".credentials.json");
const copiedConfigPath = join(harnessHome, harness === AgentRunHarness.Codex ? "config.toml" : "settings.json");

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 300_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
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
  mkdirSync(harnessHome, { recursive: true });
  mkdirSync(neutralCwd, { recursive: true });
  copyFileSync(credentialSource, copiedCredentialPath);
  copyFileSync(configSource, copiedConfigPath);
  const cleanEnv: NodeJS.ProcessEnv = {
    HOME: userHome,
    OO_HOME: ooHome,
    OO_LIVE_IDENTITY_WORKER: "1",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    // Explicit copied sources are authoritative even when the caller has ambient harness homes.
    CODEX_HOME: harness === AgentRunHarness.Codex ? harnessHome : join(userHome, "unused-codex"),
    CLAUDE_CONFIG_DIR: harness === AgentRunHarness.ClaudeCode ? harnessHome : join(userHome, "unused-claude"),
  };
  daemon = spawn(process.execPath, ["--import", absoluteTsxLoaderPath(), testPath], {
    cwd: neutralCwd,
    env: cleanEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemonExited = new Promise((resolve) => { daemon!.once("exit", () => resolve()); daemon!.once("error", () => resolve()); });
  // Drain without forwarding: a live harness may write credential-bearing diagnostics.
  daemon.stderr?.resume();
  await waitFor(async () => {
    const daemonInfo = info();
    if (!daemonInfo || daemonInfo.pid !== daemon?.pid) return;
    try { return (await request<{ ok: boolean }>("/health")).ok ? true : undefined; } catch { return; }
  }, "daemon readiness", 60_000);
  const requested = { harness, model, effort, task: "Reply with exactly OO_DELEGATED_IDENTITY_OK. Do not use tools.", cwd: neutralCwd, timeoutSeconds: 240 };
  const launched = await request<AgentRun>("/agent-runs", requested);
  assert.deepEqual({ harness: launched.harness, model: launched.model, effort: launched.effort }, { harness, model, effort });
  const finished = await waitFor(async () => {
    const row = await request<AgentRun>(`/agent-runs/${launched.id}`);
    return isTerminalAgentRunStatus(row.status) ? row : undefined;
  }, "real delegated turn");
  assert.equal(finished.status, "completed");
  assert.deepEqual({ harness: finished.harness, model: finished.model, effort: finished.effort }, { harness, model, effort });
  assert.equal(finished.harnessIdentity.observed, true, "launcher independently observed live harness identity");
  assert.equal("model" in finished.harnessIdentity ? finished.harnessIdentity.model : undefined, model,
    "live harness resolved the requested model");
  if (effort === null) {
    assert.equal(finished.effortApplied, false, "explicit null means OO applies no effort override");
  } else {
    assert.equal(finished.effortApplied, true, "requested non-null effort was applied by the live harness");
    assert.equal("effort" in finished.harnessIdentity ? finished.harnessIdentity.effort : undefined, effort,
      "live harness reports the applied effort");
  }
  assert.ok(finished.childSessionId, "lifecycle reports the real child identity");
  assert.match(finished.resultTail ?? "", /OO_DELEGATED_IDENTITY_OK/);
  const leaseDir = join(ooHome, "agent-runs", "process-leases");
  isolatedLeaseIds = existsSync(leaseDir)
    ? readdirSync(leaseDir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
    : [];
  process.stdout.write(`ok — lifecycle retained ${harness} / ${model} / effort ${String(effort)}\n`);
} finally {
  if (daemon?.pid) isolatedProcessPids = processTreePids(processList(), daemon.pid);
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGTERM");
    await waitFor(() => daemon?.exitCode !== null || daemon?.signalCode !== null ? true : undefined, "daemon exit", 15_000)
      .catch(() => daemon?.kill("SIGKILL"));
  }
  await daemonExited;
  try {
    assert.ok(!daemon?.pid || !isAlive(daemon.pid), "daemon remains gone after teardown");
    const ownedProcesses = daemon?.pid
      ? processList().filter(({ pid, command }) =>
        isolatedProcessPids.includes(pid) || isolatedLeaseIds.some((leaseId) => command.includes(leaseId)))
      : [];
    assert.deepEqual(ownedProcesses, [], "no isolated daemon wrapper or descendant remains live");
    const leaseDir = join(ooHome, "agent-runs", "process-leases");
    assert.deepEqual(existsSync(leaseDir) ? readdirSync(leaseDir).filter((name) => name.endsWith(".json")) : [], [],
      "no process lease remains before isolation is deleted");
    rmSync(userHome, { recursive: true, force: true });
  } catch (error) {
    rmSync(copiedCredentialPath, { force: true });
    rmSync(copiedConfigPath, { force: true });
    process.stderr.write(`live identity teardown failed; preserved isolation evidence at ${userHome}\n`);
    teardownError = error;
  }
}
if (teardownError) throw teardownError;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function processList(): Array<{ pid: number; ppid: number; command: string }> {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

function processTreePids(processes: ReturnType<typeof processList>, rootPid: number): number[] {
  const found = new Set([rootPid]);
  for (;;) {
    const before = found.size;
    for (const entry of processes) if (found.has(entry.ppid)) found.add(entry.pid);
    if (found.size === before) return [...found];
  }
}

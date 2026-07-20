import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownerOperatorHome } from "../shared/paths";

const LEASE_VERSION = 1;
const PROCESS_LIST_TIMEOUT_MS = 2_000;
const PROCESS_LIST_MAX_BYTES = 8 * 1024 * 1024;
const LEASE_ARG = "--oo-agent-run-lease";

interface AgentRunProcessLease {
  version: typeof LEASE_VERSION;
  leaseId: string;
  runId: string;
  ownerPid: number;
  wrapperPath: string;
  rootPid: number;
  rootCommand: string | null;
  startedAt: string;
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

export interface AgentRunProcessCleanupDeps {
  listProcesses?: () => Promise<ProcessInfo[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface AgentRunProcessCleanupResult {
  inspectedPids: number[];
  terminatedPids: number[];
  skippedReason?: "unsupported-platform" | "process-list-unavailable";
}

const leaseDir = (): string => join(ownerOperatorHome(), "agent-runs", "process-leases");
const leasePath = (leaseId: string): string => join(leaseDir(), `${leaseId}.json`);

function writeLease(lease: AgentRunProcessLease): void {
  mkdirSync(leaseDir(), { recursive: true });
  const path = leasePath(lease.leaseId);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function normalizeLease(value: unknown): AgentRunProcessLease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const lease = value as Partial<AgentRunProcessLease>;
  if (
    lease.version !== LEASE_VERSION
    || typeof lease.leaseId !== "string"
    || typeof lease.runId !== "string"
    || typeof lease.ownerPid !== "number"
    || typeof lease.wrapperPath !== "string"
    || typeof lease.rootPid !== "number"
    || !(typeof lease.rootCommand === "string" || lease.rootCommand === null)
    || typeof lease.startedAt !== "string"
  ) return;
  return lease as AgentRunProcessLease;
}

function readLease(path: string): AgentRunProcessLease | undefined {
  try {
    return normalizeLease(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return;
  }
}

function listLeases(): AgentRunProcessLease[] {
  try {
    return readdirSync(leaseDir())
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const lease = readLease(join(leaseDir(), name));
        return lease ? [lease] : [];
      });
  } catch {
    return [];
  }
}

/** Persist ownership before acpx can spawn. The root PID is filled after ACP initialization. */
export function createAgentRunProcessLease(params: {
  runId: string;
  wrapperPath: string;
}): { leaseId: string; path: string } {
  const leaseId = randomUUID();
  writeLease({
    version: LEASE_VERSION,
    leaseId,
    runId: params.runId,
    ownerPid: process.pid,
    wrapperPath: params.wrapperPath,
    rootPid: 0,
    rootCommand: null,
    startedAt: new Date().toISOString(),
  });
  return { leaseId, path: leasePath(leaseId) };
}

/** Attach the PID/command acpx reports after its wrapper process is live. */
export function updateAgentRunProcessLease(
  leaseId: string,
  update: { rootPid: number; rootCommand: string },
): void {
  const lease = readLease(leasePath(leaseId));
  if (!lease) return;
  writeLease({ ...lease, ...update });
}

export function closeAgentRunProcessLease(leaseId: string): void {
  rmSync(leasePath(leaseId), { force: true });
}

function parseProcessList(stdout: string): ProcessInfo[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.+?)\s*$/.exec(line);
    if (!match?.groups) return [];
    return [{
      pid: Number.parseInt(match.groups.pid, 10),
      ppid: Number.parseInt(match.groups.ppid, 10),
      command: match.groups.command,
    }];
  });
}

function listPlatformProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,command="],
      { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: PROCESS_LIST_MAX_BYTES, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessList(stdout));
      },
    );
  });
}

function leaseIdFromCommand(command: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${LEASE_ARG}\\s+([0-9a-f-]+)(?:\\s|$)`, "i").exec(command);
  return match?.[1];
}

function collectProcessTree(processes: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const processInfo of processes) {
    const rows = children.get(processInfo.ppid) ?? [];
    rows.push(processInfo);
    children.set(processInfo.ppid, rows);
  }
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const root = byPid.get(rootPid);
  if (!root) return [];
  const tree = [root];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length) {
    const next = queue.shift();
    if (!next || tree.some((row) => row.pid === next.pid)) continue;
    tree.push(next);
    queue.push(...(children.get(next.pid) ?? []));
  }
  return tree;
}

function uniquePids(processes: ProcessInfo[]): number[] {
  return [...new Set(
    processes
      .map((processInfo) => processInfo.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
  )];
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePids(
  pids: number[],
  deps: AgentRunProcessCleanupDeps | undefined,
): Promise<number[]> {
  const kill = deps?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const terminated: number[] = [];
  for (const pid of pids) {
    try {
      kill(pid, "SIGTERM");
      terminated.push(pid);
    } catch {
      // Already gone.
    }
  }
  if (!terminated.length) return terminated;
  await sleep(750);
  for (const pid of terminated) {
    if (deps?.killProcess || processAlive(pid)) {
      try {
        kill(pid, "SIGKILL");
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  return terminated;
}

/** Reap only orphan roots under our exact wrapper path with a matching durable lease id. */
export async function reapStaleAgentRunProcesses(params: {
  wrapperPath: string;
  deps?: AgentRunProcessCleanupDeps;
}): Promise<AgentRunProcessCleanupResult> {
  if (process.platform === "win32") {
    return { inspectedPids: [], terminatedPids: [], skippedReason: "unsupported-platform" };
  }

  let processes: ProcessInfo[];
  try {
    processes = await (params.deps?.listProcesses ?? listPlatformProcesses)();
  } catch {
    return { inspectedPids: [], terminatedPids: [], skippedReason: "process-list-unavailable" };
  }

  const leases = new Map(
    listLeases()
      .filter((lease) => lease.wrapperPath === params.wrapperPath)
      .map((lease) => [lease.leaseId, lease]),
  );
  const roots = processes.filter((processInfo) => {
    if (processInfo.ppid !== 1 || !processInfo.command.includes(params.wrapperPath)) return false;
    const leaseId = leaseIdFromCommand(processInfo.command);
    const lease = leaseId ? leases.get(leaseId) : undefined;
    return Boolean(lease && (!lease.rootPid || lease.rootPid === processInfo.pid));
  });
  const trees = roots.map((root) => collectProcessTree(processes, root.pid));
  const inspectedPids = uniquePids(trees.flat());
  const terminatedPids = await terminatePids(
    uniquePids(trees.flatMap((tree) => [...tree].reverse())),
    params.deps,
  );
  for (const root of roots) {
    const leaseId = leaseIdFromCommand(root.command);
    if (leaseId) closeAgentRunProcessLease(leaseId);
  }
  return { inspectedPids, terminatedPids };
}

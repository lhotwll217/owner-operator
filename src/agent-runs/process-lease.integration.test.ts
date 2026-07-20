import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAgentRunProcessLease,
  createAgentRunProcessLease,
  reapStaleAgentRunProcesses,
  updateAgentRunProcessLease,
} from "./process-lease";

const dir = mkdtempSync(join(tmpdir(), "oo-process-lease-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;

const wrapperPath = join(dir, "agent-runs", "agent-run-acp-wrapper.mjs");
const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];

try {
  const lease = createAgentRunProcessLease({
    runId: "run-1",
    wrapperPath,
  });
  const pending = JSON.parse(readFileSync(lease.path, "utf8")) as {
    leaseId: string;
    rootPid: number;
    ownerPid: number;
  };
  assert.equal(pending.leaseId, lease.leaseId);
  assert.equal(pending.rootPid, 0, "the durable lease exists before the child is spawned");
  assert.equal(pending.ownerPid, process.pid);

  updateAgentRunProcessLease(lease.leaseId, {
    rootPid: 410,
    rootCommand: `node ${wrapperPath} --oo-agent-run-lease ${lease.leaseId}`,
  });

  const result = await reapStaleAgentRunProcesses({
    wrapperPath,
    deps: {
      listProcesses: async () => [
        {
          pid: 410,
          ppid: 1,
          command: `node ${wrapperPath} --oo-agent-run-lease ${lease.leaseId}`,
        },
        { pid: 411, ppid: 410, command: "node claude-agent-acp" },
        {
          pid: 420,
          ppid: 1,
          command: `node ${wrapperPath} --oo-agent-run-lease another-lease`,
        },
        { pid: 430, ppid: 1, command: "node unrelated.mjs" },
      ],
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
      },
      sleep: async () => undefined,
    },
  });

  assert.deepEqual(result.inspectedPids, [410, 411]);
  assert.deepEqual(
    killed.filter((entry) => entry.signal === "SIGTERM"),
    [
      { pid: 411, signal: "SIGTERM" },
      { pid: 410, signal: "SIGTERM" },
    ],
    "a verified leased tree is terminated children-first",
  );
  assert.equal(result.terminatedPids.includes(420), false, "an unknown lease is never claimed");
  assert.throws(() => readFileSync(lease.path), /ENOENT/, "a reaped lease is removed");

  const closed = createAgentRunProcessLease({ runId: "run-2", wrapperPath });
  closeAgentRunProcessLease(closed.leaseId);
  assert.throws(() => readFileSync(closed.path), /ENOENT/, "normal close removes the lease");

  process.stdout.write("ok — ACP process leases are pre-spawn, verified, and reaped children-first\n");
} finally {
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}

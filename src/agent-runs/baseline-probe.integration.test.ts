/** Lifecycle of the throwaway session a baseline-candidate probe opens: what it writes, when the
 * traces disappear, and where it runs from. The acpx runtime is faked so the probe's own timeout
 * and late-settlement paths can be driven, but the lease it writes is the real durable one. */

import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpSessionStore,
} from "acpx/runtime";
import { AgentRunHarness } from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import { agentRunStateDir, type LeasedAcpRuntime } from "./acp-launcher";
import { createAgentRunProcessLease, closeAgentRunProcessLease } from "./process-lease";
import { discoverAcpBaselineCandidate } from "./harness-details";

const WRAPPER_PATH = "/nonexistent/acp-process-wrapper.mjs";
const PROBE_TIMEOUT_MS = 50;
const HANDLE = { sessionId: "probe-session" } as unknown as AcpRuntimeHandle;
const STATUS = {
  models: { currentModelId: "gpt-5.6-sol" },
  details: {
    configOptions: [
      { id: "reasoning_effort", currentValue: "low", options: [{ value: "low" }, { value: "high" }] },
    ],
  },
};

interface Rig {
  createRuntime: (params: {
    harness: AgentRunHarness;
    leaseKey: string;
    stateDir: string;
  }) => LeasedAcpRuntime;
  ensureInputs: AcpRuntimeEnsureInput[];
  closeReasons: string[];
  stateDirs: string[];
  openSession: () => void;
  failSession: (error: Error) => void;
  terminationCalls: () => number;
}

/** A fake leased runtime whose session opening is driven by the test. It writes the same durable
 * traces the real one does — a process lease and a session directory — so their removal is
 * observable. */
function probeRig(params: { openImmediately: boolean; terminationFails?: boolean; status?: unknown }): Rig {
  const ensureInputs: AcpRuntimeEnsureInput[] = [];
  const closeReasons: string[] = [];
  const stateDirs: string[] = [];
  let openSession = (): void => {};
  let failSession = (_error: Error): void => {};
  let terminationCalls = 0;
  const session = new Promise<AcpRuntimeHandle>((resolve, reject) => {
    openSession = () => resolve(HANDLE);
    failSession = reject;
  });
  if (params.openImmediately) openSession();

  const createRuntime = (create: { leaseKey: string; stateDir: string }): LeasedAcpRuntime => {
    const lease = createAgentRunProcessLease({ runId: create.leaseKey, wrapperPath: WRAPPER_PATH });
    mkdirSync(create.stateDir, { recursive: true });
    writeFileSync(join(create.stateDir, "session.json"), "{}");
    stateDirs.push(create.stateDir);
    const runtime = {
      ensureSession: (input: AcpRuntimeEnsureInput) => {
        ensureInputs.push(input);
        return session;
      },
      getStatus: async () => params.status ?? STATUS,
      close: async (input: { reason: string }) => {
        closeReasons.push(input.reason);
      },
    } as unknown as AcpRuntime;
    return {
      runtime,
      sessionStore: {} as AcpSessionStore,
      leaseId: lease.leaseId,
      release: () => closeAgentRunProcessLease(lease.leaseId),
      processTreePids: async () => [],
      terminate: async () => {
        terminationCalls += 1;
        if (params.terminationFails) return false;
        closeAgentRunProcessLease(lease.leaseId);
        return true;
      },
    };
  };

  return {
    createRuntime, ensureInputs, closeReasons, stateDirs, openSession, failSession,
    terminationCalls: () => terminationCalls,
  };
}

const leaseFiles = (): string[] => {
  try {
    return readdirSync(join(agentRunStateDir(), "process-leases")).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};

// Resolved: macOS hands out a symlinked temp path, and process.cwd() reports the real one.
const home = realpathSync(mkdtempSync(join(tmpdir(), "oo-baseline-probe-home-")));
const project = realpathSync(mkdtempSync(join(tmpdir(), "oo-baseline-probe-project-")));
const previousOoHome = process.env.OO_HOME;
const previousCwd = process.cwd();
process.env.OO_HOME = home;

try {
  // --- A probe runs from a fixed neutral directory, never the caller's -------------------------

  // Stand in for project-local harness config that would change what the harness selects.
  writeFileSync(join(project, "AGENTS.md"), "# project-local harness config\n");
  process.chdir(project);

  const settled = probeRig({ openImmediately: true });
  const candidate = await discoverAcpBaselineCandidate(AgentRunHarness.Codex, {
    createRuntime: settled.createRuntime,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.deepEqual(candidate, {
    model: "gpt-5.6-sol",
    effort: "low",
    availableEfforts: ["low", "high"],
  }, "the probe reports what the harness selected for itself");

  assert.equal(settled.ensureInputs.length, 1);
  assert.equal(
    settled.ensureInputs[0]?.cwd,
    ownerOperatorHome(),
    "the probe session opens in the stable neutral directory",
  );
  assert.notEqual(
    settled.ensureInputs[0]?.cwd,
    process.cwd(),
    "the caller's cwd never reaches ensureSession, so project-local config cannot contaminate a global candidate",
  );
  assert.equal(process.cwd(), project, "the probe does not move the caller");
  assert.deepEqual(leaseFiles(), [], "a settled probe drops its lease");
  assert.equal(existsSync(settled.stateDirs[0] ?? ""), false, "a settled probe deletes its session directory");

  for (const [status, message] of [
    [{ models: { currentModelId: null }, details: {} }, /no usable model/],
    [{ models: { currentModelId: "model" }, details: { configOptions: [
      { id: "reasoning_effort", currentValue: "turbo", options: [{ value: "turbo" }] },
    ] } }, /unsupported effort/],
  ] as const) {
    const invalid = probeRig({ openImmediately: true, status });
    await assert.rejects(discoverAcpBaselineCandidate(AgentRunHarness.Codex, {
      createRuntime: invalid.createRuntime, timeoutMs: PROBE_TIMEOUT_MS,
    }), message);
    assert.equal(existsSync(invalid.stateDirs[0] ?? ""), false, "invalid discovery still cleans its probe directory");
  }

  process.chdir(previousCwd);

  // --- A never-settling initialization is actively terminated at the deadline -----------------

  const late = probeRig({ openImmediately: false });
  await assert.rejects(
    discoverAcpBaselineCandidate(AgentRunHarness.Codex, {
      createRuntime: late.createRuntime,
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    /did not finish initializing/,
    "a harness that never initializes fails the probe rather than hanging it",
  );
  assert.equal(late.terminationCalls(), 1, "timeout invokes the owned pre-handle termination seam");
  assert.deepEqual(leaseFiles(), [], "confirmed termination drops the lease before returning");
  assert.equal(existsSync(late.stateDirs[0] ?? ""), false, "timeout deletes the probe session directory");
  assert.deepEqual(late.closeReasons, [], "pre-handle termination does not require a session handle");

  // --- Only a child that resisted close keeps its lease ----------------------------------------

  const stuck = probeRig({ openImmediately: false, terminationFails: true });
  await assert.rejects(
    discoverAcpBaselineCandidate(AgentRunHarness.Codex, {
      createRuntime: stuck.createRuntime,
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    /did not finish initializing/,
  );
  assert.equal(stuck.terminationCalls(), 1);
  assert.equal(existsSync(stuck.stateDirs[0] ?? ""), true,
    "failed termination retains the disposable probe directory as evidence");
  assert.equal(
    leaseFiles().length,
    1,
    "a wrapper whose termination could not be confirmed keeps its lease for startup reaping",
  );

  process.stdout.write("ok — baseline probes clean confirmed trees and retain failed-termination evidence\n");
} finally {
  process.chdir(previousCwd);
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

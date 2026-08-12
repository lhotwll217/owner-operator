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
}

/** A fake leased runtime whose session opening is driven by the test. It writes the same durable
 * traces the real one does — a process lease and a session directory — so their removal is
 * observable. */
function probeRig(params: { openImmediately: boolean; closeFails?: boolean }): Rig {
  const ensureInputs: AcpRuntimeEnsureInput[] = [];
  const closeReasons: string[] = [];
  const stateDirs: string[] = [];
  let openSession = (): void => {};
  let failSession = (_error: Error): void => {};
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
      getStatus: async () => STATUS,
      close: async (input: { reason: string }) => {
        closeReasons.push(input.reason);
        if (params.closeFails) throw new Error("child resisted close");
      },
    } as unknown as AcpRuntime;
    return {
      runtime,
      sessionStore: {} as AcpSessionStore,
      leaseId: lease.leaseId,
      release: () => closeAgentRunProcessLease(lease.leaseId),
    };
  };

  return { createRuntime, ensureInputs, closeReasons, stateDirs, openSession, failSession };
}

const leaseFiles = (): string[] => {
  try {
    return readdirSync(join(agentRunStateDir(), "process-leases")).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};

async function waitFor(what: string, condition: () => boolean): Promise<void> {
  const until = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  process.chdir(previousCwd);

  // --- A timed-out probe keeps its traces until the abandoned session settles ------------------

  const late = probeRig({ openImmediately: false });
  await assert.rejects(
    discoverAcpBaselineCandidate(AgentRunHarness.Codex, {
      createRuntime: late.createRuntime,
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    /did not finish initializing/,
    "a harness that never initializes fails the probe rather than hanging it",
  );
  assert.equal(leaseFiles().length, 1, "an in-flight probe keeps its lease: the wrapper may still be coming up");
  assert.equal(existsSync(late.stateDirs[0] ?? ""), true, "and keeps its session directory");
  assert.deepEqual(late.closeReasons, [], "there is nothing to close before the session opens");

  // The session opens after the probe already gave up: that late child is still ours to close.
  late.openSession();
  await waitFor("the late-settling probe to clean up", () =>
    leaseFiles().length === 0 && !existsSync(late.stateDirs[0] ?? ""));
  assert.deepEqual(
    late.closeReasons,
    ["baseline candidate probe abandoned"],
    "the child opened after the timeout is closed, not stranded",
  );

  // --- A probe whose session fails after the timeout also cleans up ----------------------------

  const failed = probeRig({ openImmediately: false });
  await assert.rejects(
    discoverAcpBaselineCandidate(AgentRunHarness.Codex, {
      createRuntime: failed.createRuntime,
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    /did not finish initializing/,
  );
  failed.failSession(new Error("harness never initialized"));
  await waitFor("the failed probe to clean up", () =>
    leaseFiles().length === 0 && !existsSync(failed.stateDirs[0] ?? ""));
  assert.deepEqual(failed.closeReasons, [], "a session that never opened has no child to close");

  // --- Only a child that resisted close keeps its lease ----------------------------------------

  const stuck = probeRig({ openImmediately: false, closeFails: true });
  await assert.rejects(
    discoverAcpBaselineCandidate(AgentRunHarness.Codex, {
      createRuntime: stuck.createRuntime,
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    /did not finish initializing/,
  );
  stuck.openSession();
  await waitFor("the stuck probe to drop its session directory", () =>
    !existsSync(stuck.stateDirs[0] ?? ""));
  assert.equal(
    leaseFiles().length,
    1,
    "a wrapper that resisted close keeps its lease so startup reaping can still find it",
  );

  process.stdout.write("ok — a baseline probe runs neutral and strands no lease, session, or child\n");
} finally {
  process.chdir(previousCwd);
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

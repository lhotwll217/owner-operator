/** The durable trace `createLeasedAcpRuntime` leaves behind: exactly one process lease per runtime
 * it hands back, and none at all when setup fails. The lease is taken before the runtime is built,
 * so a build that throws is the case that can strand it. */

import assert from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness } from "@owner-operator/core";
import { agentRunStateDir, createLeasedAcpRuntime } from "./acp-launcher";

const dir = mkdtempSync(join(tmpdir(), "oo-leased-runtime-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;

const leaseFiles = (): string[] => {
  try {
    return readdirSync(join(agentRunStateDir(), "process-leases")).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};

try {
  // --- Resolving the harness's adapter can fail before anything is spawned ----------------------

  // The shape of a broken install: the adapter the harness needs cannot be resolved.
  assert.throws(
    () => createLeasedAcpRuntime({
      harness: AgentRunHarness.Codex,
      leaseKey: "setup-failure",
      stateDir: join(dir, "setup-failure"),
      resolveAgentCommand: () => { throw new Error("codex adapter is not installed"); },
    }),
    /codex adapter is not installed/,
    "a setup failure surfaces to the caller rather than being swallowed",
  );
  assert.deepEqual(
    leaseFiles(),
    [],
    "a lease with no process to own is rolled back: nothing was spawned, so nothing would ever reap it",
  );

  // --- A runtime that was handed back owns exactly one lease until it is released ---------------

  const leased = createLeasedAcpRuntime({
    harness: AgentRunHarness.Codex,
    leaseKey: "built",
    stateDir: join(dir, "built"),
    resolveAgentCommand: () => "node /nonexistent/adapter.js",
  });
  assert.deepEqual(
    leaseFiles(),
    [`${leased.leaseId}.json`],
    "the lease is durable before the caller can open a session, so a crash leaves a reapable identity",
  );

  leased.release();
  assert.deepEqual(leaseFiles(), [], "releasing the runtime drops its lease");

  process.stdout.write("ok — a leased acpx runtime strands no lease, built or failed\n");
} finally {
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}

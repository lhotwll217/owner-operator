// e2e: harness observation and baseline proposal run inside the daemon. `oo harness details`
// prints the route's snapshot unchanged, `propose` never saves, and `approve` persists exactly the
// model and effort (or explicit null) it was given.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, loadDelegatedBaseline, ownerOperatorPaths, type HarnessDetailsRequest } from "@owner-operator/core";
import { proposeDelegatedBaseline } from "../agent-runs/launch-config";
import { repoRoot } from "../shared/repo-root";

const ooHome = mkdtempSync(join(tmpdir(), "oo-harness-e2e-"));
process.env.OO_HOME = ooHome;
let daemon: Awaited<ReturnType<typeof import("../daemon/runtime")["startDaemon"]>> | null = null;

const runOo = async (args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(join(repoRoot, "oo"), args, { cwd: repoRoot, env: { ...process.env, OO_HOME: ooHome } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });

try {
  const requests: HarnessDetailsRequest[] = [];
  const proposals: string[] = [];
  const { startDaemon } = await import("../daemon/runtime");
  daemon = await startDaemon({
    port: 0,
    dbPath: join(ooHome, "state.db"),
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
    harness: {
      details: async (request) => {
        requests.push(request);
        return { observedAt: "2026-09-23T00:00:00.000Z", ephemeral: true, echo: request, capabilities: { harnesses: [] }, account: [], unknowns: [] };
      },
      propose: async (harness) => {
        proposals.push(harness);
        return await proposeDelegatedBaseline(harness, {
          discover: async () => ({ model: "observed[1m]", effort: "high", availableEfforts: ["low", "high"] }),
        });
      },
    },
  });

  const cli = await runOo([
    "harness", "details", "--harness", "codex", "--harness", "cursor",
    "--inspect", "claude-code:opus[1m]:high", "--inspect", "opencode:provider/model:with:colons",
    "--baseline-candidates", "--json",
  ]);
  assert.equal(cli.status, 0, cli.stderr);
  const input = {
    harnesses: ["codex", "cursor"],
    inspect: [
      { harness: "claude-code", model: "opus[1m]", effort: "high" },
      { harness: "opencode", model: "provider/model:with:colons", effort: null },
    ],
    includeBaselineCandidates: true,
  } as HarnessDetailsRequest;
  assert.deepEqual(requests[0], input, "the CLI sends the parsed request; an omitted effort is null and model colons survive");
  assert.deepEqual(JSON.parse(cli.stdout).echo, input, "--json prints the route's snapshot unchanged");

  const unknown = await runOo(["harness", "details", "--harness", "nope"]);
  assert.equal(unknown.status, 2, "an unknown harness is a usage error before any observation");
  assert.equal(requests.length, 1);

  const baselinePath = join(ownerOperatorPaths(ooHome).delegatedBaselines, "codex.json");
  const proposed = await runOo(["harness", "propose", "codex", "--json"]);
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.deepEqual(JSON.parse(proposed.stdout), {
    harness: "codex",
    approved: null,
    candidate: { model: "observed[1m]", effort: "high", availableEfforts: ["low", "high"] },
    error: null,
    differs: true,
  });
  assert.deepEqual(proposals, ["codex"]);
  assert.equal(existsSync(baselinePath), false, "propose never saves");

  for (const args of [
    ["--effort", "high"],
    ["--model", "observed[1m]"],
    ["--model", "observed[1m]", "--effort", "extreme"],
  ]) {
    const refused = await runOo(["harness", "approve", "codex", ...args]);
    assert.equal(refused.status, 2, `approve ${args.join(" ")} is a usage error`);
  }
  assert.equal(existsSync(baselinePath), false, "approve without an explicit model and effort-or-null saves nothing");

  const approved = await runOo(["harness", "approve", "codex", "--model", "observed[1m]", "--effort", "high", "--json"]);
  assert.equal(approved.status, 0, approved.stderr);
  assert.deepEqual(loadDelegatedBaseline(AgentRunHarness.Codex, ooHome), JSON.parse(approved.stdout));
  assert.equal(JSON.parse(approved.stdout).effort, "high");
  const nulled = await runOo(["harness", "approve", "claude-code", "--model", "opus", "--effort", "none"]);
  assert.equal(nulled.status, 0, nulled.stderr);
  assert.match(nulled.stdout, /approved claude-code: opus effort=null/);
  assert.equal(loadDelegatedBaseline(AgentRunHarness.ClaudeCode, ooHome)?.effort, null, "--effort none persists an explicit null");
  const reproposed = await runOo(["harness", "propose", "codex"]);
  assert.match(reproposed.stdout, /differs:\s+false/, "a proposal matching the approved baseline does not differ");
  const badRoute = await (await import("../gateway/client")).resolveBackend()
    .then((gateway) => gateway.harnessDetails({ harnesses: ["nope" as never] }))
    .then(() => null, (error: Error) => error.message);
  assert.match(badRoute ?? "", /400 harnesses must be supported harness ids/, "the route validates its own inputs");
} finally {
  (await import("../gateway/client")).resolveBackend().then((gateway) => gateway.close(), () => undefined);
  await daemon?.close();
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — oo harness: details snapshot, read-only propose, exact approve through the daemon\n");

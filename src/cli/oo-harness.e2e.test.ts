// e2e: harness details run inside the daemon. The native tool and `oo harness details` send the
// same request to POST /harness-details and return the same snapshot.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessDetailsRequest } from "@owner-operator/core";
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
    },
  });

  const cli = await runOo([
    "harness", "details", "--harness", "codex", "--harness", "cursor",
    "--inspect", "claude-code:opus[1m]:high", "--inspect", "opencode:provider/model:with:colons", "--json",
  ]);
  assert.equal(cli.status, 0, cli.stderr);
  const input = {
    harnesses: ["codex", "cursor"],
    inspect: [
      { harness: "claude-code", model: "opus[1m]", effort: "high" },
      { harness: "opencode", model: "provider/model:with:colons", effort: null },
    ],
  } as HarnessDetailsRequest;
  assert.deepEqual(requests[0], input, "the CLI sends the parsed request; an omitted effort is null and model colons survive");

  const { createGetHarnessDetailsTool } = await import("../agent/tools/get-harness-details");
  const tool = createGetHarnessDetailsTool();
  const native = await tool.execute("call", input as never, undefined, undefined, {} as never);
  assert.deepEqual(requests[1], input, "the native tool sends the same request to the same route");
  assert.deepEqual(JSON.parse(cli.stdout), native.details, "native tool and CLI return the same snapshot");

  const unknown = await runOo(["harness", "details", "--harness", "nope"]);
  assert.equal(unknown.status, 2, "an unknown harness is a usage error before any observation");
  assert.equal(requests.length, 2);
  const badRoute = await (await import("../gateway/client")).resolveBackend()
    .then((gateway) => gateway.harnessDetails({ harnesses: ["nope" as never] }))
    .then(() => null, (error: Error) => error.message);
  assert.match(badRoute ?? "", /400 harnesses must be supported harness ids/, "the route validates its own inputs");
} finally {
  (await import("../gateway/client")).resolveBackend().then((gateway) => gateway.close(), () => undefined);
  await daemon?.close();
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — harness details: CLI and native tool share POST /harness-details and its snapshot\n");

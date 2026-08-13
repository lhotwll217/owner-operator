import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AgentRunHarness } from "./agent-runs";
import { approveDelegatedBaseline, loadDelegatedBaseline, loadDelegatedBaselines } from "./delegated-baselines";
import { ownerOperatorPaths } from "./harness.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-delegated-baselines-"));
try {
  assert.deepEqual(loadDelegatedBaselines(ooHome), {});
  const claudeModel = " claude-opaque-id:2026/08@account ";
  approveDelegatedBaseline(AgentRunHarness.ClaudeCode, { model: claudeModel, effort: null }, ooHome);
  approveDelegatedBaseline(AgentRunHarness.Codex, { model: "codex-current", effort: "high" }, ooHome);
  assert.equal(loadDelegatedBaseline(AgentRunHarness.ClaudeCode, ooHome)?.model, claudeModel);
  assert.equal(loadDelegatedBaseline(AgentRunHarness.ClaudeCode, ooHome)?.effort, null);
  assert.equal(loadDelegatedBaseline(AgentRunHarness.Codex, ooHome)?.effort, "high");
  approveDelegatedBaseline(AgentRunHarness.Codex, { model: "codex-frontier", effort: "ultra" }, ooHome);
  assert.equal(loadDelegatedBaseline(AgentRunHarness.Codex, ooHome)?.effort, "ultra");
  const baselinesDirectory = ownerOperatorPaths(ooHome).delegatedBaselines;
  assert.match(readFileSync(join(baselinesDirectory, "claude-code.json"), "utf8"), /\\u0020| claude-opaque-id:2026\/08@account /);
  assert.throws(
    () => approveDelegatedBaseline(AgentRunHarness.Codex, { model: "model", effort: "turbo" as "high" }, ooHome),
    /unknown delegation effort/,
  );
  assert.throws(
    () => approveDelegatedBaseline(AgentRunHarness.Codex, { model: "model" } as never, ooHome),
    /explicit effort/,
  );

  const malformed = join(baselinesDirectory, "codex.json");
  for (const entry of [
    { model: "missing-effort", approvedAt: "now" },
    { model: "missing-approved-at", effort: "high" },
    { model: "bad-effort", effort: "turbo", approvedAt: "now" },
    { model: "bad-approved-at", effort: null, approvedAt: null },
  ]) {
    writeFileSync(malformed, JSON.stringify(entry));
    assert.equal(loadDelegatedBaseline(AgentRunHarness.Codex, ooHome), null, "incomplete approval fails closed");
  }

  rmSync(baselinesDirectory, { recursive: true, force: true });
  mkdirSync(baselinesDirectory, { recursive: true });
  const moduleUrl = new URL("./delegated-baselines.ts", import.meta.url).href;
  const harnessUrl = new URL("./agent-runs.ts", import.meta.url).href;
  const approveInProcess = (harness: string, model: string, effort: string) => new Promise<void>((resolve, reject) => {
    const script = `import { approveDelegatedBaseline } from ${JSON.stringify(moduleUrl)}; import { AgentRunHarness } from ${JSON.stringify(harnessUrl)}; approveDelegatedBaseline(AgentRunHarness[${JSON.stringify(harness)}], { model: ${JSON.stringify(model)}, effort: ${effort} }, ${JSON.stringify(ooHome)});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`approval process exited ${code}: ${stderr}`)));
  });
  await Promise.all([
    approveInProcess("ClaudeCode", "concurrent-claude", "null"),
    approveInProcess("Codex", "concurrent-codex", '"high"'),
  ]);
  assert.equal(loadDelegatedBaseline(AgentRunHarness.ClaudeCode, ooHome)?.model, "concurrent-claude");
  assert.equal(loadDelegatedBaseline(AgentRunHarness.Codex, ooHome)?.model, "concurrent-codex");
  process.stdout.write("ok — strict approved baselines persist concurrently without cross-harness lost updates\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

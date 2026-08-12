import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(readFileSync(ownerOperatorPaths(ooHome).delegatedBaselines, "utf8"), /\\u0020| claude-opaque-id:2026\/08@account /);
  assert.throws(
    () => approveDelegatedBaseline(AgentRunHarness.Codex, { model: "model", effort: "turbo" as "high" }, ooHome),
    /unknown delegation effort/,
  );
  process.stdout.write("ok — approved delegated baselines persist per harness without guessed values\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

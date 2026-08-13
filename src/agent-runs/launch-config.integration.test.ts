import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, approveDelegatedBaseline } from "@owner-operator/core";
import { proposeDelegatedBaseline, resolveAgentRunLaunch } from "./launch-config";

const ooHome = mkdtempSync(join(tmpdir(), "oo-launch-config-"));
try {
  assert.throws(() => resolveAgentRunLaunch(AgentRunHarness.Codex, {}, ooHome), /no approved delegated baseline/);
  approveDelegatedBaseline(AgentRunHarness.Codex, { model: "approved-model", effort: "high" }, ooHome);
  assert.deepEqual(resolveAgentRunLaunch(AgentRunHarness.Codex, {}, ooHome), { model: "approved-model", effort: "high" });
  assert.deepEqual(
    resolveAgentRunLaunch(AgentRunHarness.Codex, { model: "caller-model", effort: "minimal" }, ooHome),
    { model: "caller-model", effort: "minimal" },
  );
  assert.deepEqual(
    resolveAgentRunLaunch(AgentRunHarness.Codex, { model: "frontier", effort: "ultra" }, ooHome),
    { model: "frontier", effort: "ultra" },
  );
  assert.deepEqual(
    resolveAgentRunLaunch(AgentRunHarness.Codex, { effort: null }, ooHome),
    { model: "approved-model", effort: null },
  );
  assert.throws(
    () => resolveAgentRunLaunch(AgentRunHarness.Codex, { model: null }, ooHome),
    /explicit null does not use the approved baseline/,
    "an explicit null model never silently falls back to the approved baseline",
  );
  const refresh = await proposeDelegatedBaseline(AgentRunHarness.Codex, {
    ooHome,
    discover: async () => ({ model: "candidate-model", effort: "medium", availableEfforts: ["medium"] }),
  });
  assert.equal(refresh.differs, true);
  assert.equal(refresh.approved?.model, "approved-model");
  assert.equal(refresh.candidate?.model, "candidate-model");
  assert.equal(resolveAgentRunLaunch(AgentRunHarness.Codex, {}, ooHome).model, "approved-model");
  const failed = await proposeDelegatedBaseline(AgentRunHarness.ClaudeCode, {
    ooHome,
    discover: async () => { throw new Error("harness unavailable"); },
  });
  assert.equal(failed.candidate, null);
  assert.match(failed.error ?? "", /harness unavailable/);
  assert.equal(failed.approved, null);
  for (const [candidate, message] of [
    [{ model: null, effort: null, availableEfforts: null }, /no usable model/],
    [{ model: "candidate", effort: "turbo", availableEfforts: ["turbo"] as string[] }, /unsupported effort/],
  ] as const) {
    const unusable = await proposeDelegatedBaseline(AgentRunHarness.Codex, {
      ooHome,
      discover: async () => candidate,
    });
    assert.equal(unusable.candidate, null, "a non-approvable identity is never returned as a candidate");
    assert.match(unusable.error ?? "", message);
  }
  const nullable = await proposeDelegatedBaseline(AgentRunHarness.ClaudeCode, {
    ooHome,
    discover: async () => ({ model: "claude-default", effort: null, availableEfforts: null }),
  });
  assert.deepEqual(nullable.candidate, {
    model: "claude-default", effort: null, availableEfforts: null,
  }, "a usable model with nullable effort remains approvable");
  process.stdout.write("ok — delegated launch baselines require approval and preserve explicit pins\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

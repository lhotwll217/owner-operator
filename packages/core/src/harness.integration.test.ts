import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SKILL_POLICY,
  DEFAULT_TOOL_POSTURE,
  HARNESS_ROSTER_TEMPLATE,
  ensureOwnerOperatorWorkspace,
  loadHarnessSettings,
  ownerOperatorPaths,
  saveHarnessSettings,
} from "./harness.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-harness-"));

try {
  const paths = ownerOperatorPaths(ooHome);
  assert.equal(paths.home, ooHome);
  assert.equal(paths.workspace, join(ooHome, "workspace"));
  assert.equal(paths.piAgentDir, join(ooHome, "pi"));
  assert.equal(paths.piPermissionConfig, join(ooHome, "pi", "extensions", "pi-permission-system", "config.json"));

  ensureOwnerOperatorWorkspace(ooHome);
  assert.ok(existsSync(paths.workspaceInstructions), "workspace AGENTS.md is seeded");
  assert.ok(existsSync(paths.workspaceMemory), "workspace MEMORY.md is seeded");
  assert.ok(existsSync(paths.workspaceSkills), "workspace skills directory exists");
  assert.ok(existsSync(paths.workspaceArtifacts), "workspace artifacts directory exists");
  assert.equal(readFileSync(paths.harnessRoster, "utf8"), HARNESS_ROSTER_TEMPLATE);
  assert.doesNotMatch(HARNESS_ROSTER_TEMPLATE, /claude-code|codex|sonnet|gpt-/i);
  assert.ok(existsSync(paths.piAgentDir), "owned Pi config directory exists");

  writeFileSync(paths.workspaceInstructions, "Owner instructions stay mine.\n");
  writeFileSync(paths.harnessRoster, "# My harness roster\n\nKeep this exact preference.\n");
  ensureOwnerOperatorWorkspace(ooHome);
  assert.equal(
    readFileSync(paths.workspaceInstructions, "utf8"),
    "Owner instructions stay mine.\n",
    "re-entry never overwrites owner-edited bootstrap files",
  );
  assert.equal(
    readFileSync(paths.harnessRoster, "utf8"),
    "# My harness roster\n\nKeep this exact preference.\n",
    "re-entry never overwrites the owner-edited roster",
  );

  const defaults = loadHarnessSettings(ooHome);
  assert.deepEqual(defaults.skillPolicy, DEFAULT_SKILL_POLICY);
  assert.deepEqual(defaults.toolPosture, DEFAULT_TOOL_POSTURE);
  assert.equal(defaults.permissionMode, "allow", "missing settings use the production permissive default");

  writeFileSync(paths.settings, JSON.stringify({ activeWindow: "24h" }));
  assert.equal(loadHarnessSettings(ooHome).permissionMode, "allow", "valid settings without a mode use Allow");

  writeFileSync(paths.settings, "{ invalid settings");
  assert.equal(loadHarnessSettings(ooHome).permissionMode, "read-only", "invalid settings fail closed");

  writeFileSync(paths.settings, JSON.stringify({ permissionMode: "unexpected" }));
  assert.equal(loadHarnessSettings(ooHome).permissionMode, "read-only", "an invalid explicit mode fails closed");

  saveHarnessSettings(ooHome, {
    activeWindow: "36h",
    skillPolicy: { mode: "allowlist", allowlist: ["calendar", "calendar", " mail "] },
  });
  const configured = loadHarnessSettings(ooHome);
  assert.equal(configured.activeWindow, "36h");
  assert.deepEqual(configured.skillPolicy, { mode: "allowlist", allowlist: ["calendar", "mail"] });

  process.stdout.write("ok — harness: owned paths, missing-only workspace, permissive fresh settings\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

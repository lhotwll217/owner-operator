import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SKILL_POLICY,
  DEFAULT_TOOL_POSTURE,
  USER_HARNESS_PREFERENCES_TEMPLATE,
  ensureOwnerOperatorWorkspace,
  loadHarnessSettings,
  ownerOperatorPaths,
  resolveUserHarnessPreferences,
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
  assert.equal(readFileSync(paths.userHarnessPreferences, "utf8"), USER_HARNESS_PREFERENCES_TEMPLATE);
  assert.doesNotMatch(USER_HARNESS_PREFERENCES_TEMPLATE, /claude-code|codex|sonnet|gpt-/i);
  assert.equal(existsSync(join(paths.workspace, "harness-roster.md")), false, "fresh setup creates only the canonical preference file");
  assert.ok(existsSync(paths.piAgentDir), "owned Pi config directory exists");

  writeFileSync(paths.workspaceInstructions, "Owner instructions stay mine.\n");
  writeFileSync(paths.userHarnessPreferences, "# My preferences\n\nKeep this exact preference.\n");
  ensureOwnerOperatorWorkspace(ooHome);
  assert.equal(
    readFileSync(paths.workspaceInstructions, "utf8"),
    "Owner instructions stay mine.\n",
    "re-entry never overwrites owner-edited bootstrap files",
  );
  assert.equal(
    readFileSync(paths.userHarnessPreferences, "utf8"),
    "# My preferences\n\nKeep this exact preference.\n",
    "re-entry never overwrites owner-edited preferences",
  );

  const legacyOnlyHome = mkdtempSync(join(tmpdir(), "oo-harness-legacy-"));
  const legacyOnlyPaths = ownerOperatorPaths(legacyOnlyHome);
  mkdirSync(legacyOnlyPaths.workspace, { recursive: true });
  const legacyOnlyPath = join(legacyOnlyPaths.workspace, "harness-roster.md");
  const legacyBytes = Buffer.from([0x23, 0x20, 0x4f, 0x77, 0x6e, 0x65, 0x72, 0x0a, 0xff, 0x00, 0x0a]);
  writeFileSync(legacyOnlyPath, legacyBytes);
  ensureOwnerOperatorWorkspace(legacyOnlyHome);
  const legacyOnly = resolveUserHarnessPreferences(legacyOnlyHome);
  assert.equal(legacyOnly.path, legacyOnlyPath, "a legacy roster resolves in place");
  assert.equal(legacyOnly.source, "legacy-harness-roster");
  assert.deepEqual(readFileSync(legacyOnlyPath), legacyBytes, "the legacy owner file is never rewritten");
  assert.equal(
    existsSync(legacyOnlyPaths.userHarnessPreferences),
    false,
    "no canonical file is created while a legacy roster exists",
  );
  rmSync(legacyOnlyHome, { recursive: true, force: true });

  const bothHome = mkdtempSync(join(tmpdir(), "oo-harness-both-"));
  const bothPaths = ownerOperatorPaths(bothHome);
  mkdirSync(bothPaths.workspace, { recursive: true });
  const bothLegacy = join(bothPaths.workspace, "harness-roster.md");
  writeFileSync(bothPaths.userHarnessPreferences, "canonical owner prose\n");
  writeFileSync(bothLegacy, "legacy owner prose\n");
  const conflict = resolveUserHarnessPreferences(bothHome);
  assert.equal(conflict.path, bothPaths.userHarnessPreferences, "the canonical file wins when both exist");
  assert.equal(conflict.source, "user-harness-preferences");
  assert.equal(readFileSync(bothLegacy, "utf8"), "legacy owner prose\n", "conflicts never merge owner prose");
  rmSync(bothHome, { recursive: true, force: true });

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

  process.stdout.write("ok — harness: canonical-first preference resolution and permissive settings\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

import assert from "node:assert";
import {
  existsSync,
  linkSync as fsLinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync as fsUnlinkSync,
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
  assert.deepEqual(readFileSync(legacyOnlyPaths.userHarnessPreferences), legacyBytes, "legacy migration preserves exact bytes");
  assert.equal(existsSync(legacyOnlyPath), false, "successful migration leaves one preference truth");
  rmSync(legacyOnlyHome, { recursive: true, force: true });

  const bothHome = mkdtempSync(join(tmpdir(), "oo-harness-both-"));
  const bothPaths = ownerOperatorPaths(bothHome);
  mkdirSync(bothPaths.workspace, { recursive: true });
  const bothLegacy = join(bothPaths.workspace, "harness-roster.md");
  writeFileSync(bothPaths.userHarnessPreferences, "canonical owner prose\n");
  writeFileSync(bothLegacy, "legacy owner prose\n");
  const conflict = resolveUserHarnessPreferences(bothHome);
  assert.equal(conflict.path, bothPaths.userHarnessPreferences);
  assert.equal(conflict.source, "user-harness-preferences");
  assert.match(conflict.error ?? "", /both .* exist.*canonical.*legacy.*untouched/i);
  assert.equal(readFileSync(bothPaths.userHarnessPreferences, "utf8"), "canonical owner prose\n");
  assert.equal(readFileSync(bothLegacy, "utf8"), "legacy owner prose\n", "conflicts never merge owner prose");
  rmSync(bothHome, { recursive: true, force: true });

  const concurrentHome = mkdtempSync(join(tmpdir(), "oo-harness-concurrent-"));
  const concurrentPaths = ownerOperatorPaths(concurrentHome);
  const winner = "concurrent owner prose\n";
  const concurrent = resolveUserHarnessPreferences(concurrentHome, {
    writeFileSync(path) {
      writeFileSync(path, winner, { flag: "wx" });
      throw Object.assign(new Error("concurrent create"), { code: "EEXIST" });
    },
  });
  assert.equal(concurrent.source, "user-harness-preferences");
  assert.equal(readFileSync(concurrentPaths.userHarnessPreferences, "utf8"), winner, "concurrent canonical file wins");
  rmSync(concurrentHome, { recursive: true, force: true });

  const canonicalRaceHome = mkdtempSync(join(tmpdir(), "oo-harness-canonical-race-"));
  const canonicalRacePaths = ownerOperatorPaths(canonicalRaceHome);
  mkdirSync(canonicalRacePaths.workspace, { recursive: true });
  const canonicalRaceLegacy = join(canonicalRacePaths.workspace, "harness-roster.md");
  const canonicalWinnerBytes = Buffer.from("canonical race winner\n");
  writeFileSync(canonicalRaceLegacy, legacyBytes);
  const canonicalRace = resolveUserHarnessPreferences(canonicalRaceHome, {
    linkSync(oldPath, newPath) {
      writeFileSync(newPath, canonicalWinnerBytes, { flag: "wx" });
      fsLinkSync(oldPath, newPath);
    },
  });
  assert.equal(canonicalRace.path, canonicalRacePaths.userHarnessPreferences);
  assert.equal(canonicalRace.source, "user-harness-preferences");
  assert.match(canonicalRace.error ?? "", /both .* exist.*canonical.*legacy.*untouched/i);
  assert.deepEqual(readFileSync(canonicalRacePaths.userHarnessPreferences), canonicalWinnerBytes,
    "canonical creation between check and move wins without clobbering bytes");
  assert.deepEqual(readFileSync(canonicalRaceLegacy), legacyBytes, "losing migration leaves legacy bytes untouched");
  rmSync(canonicalRaceHome, { recursive: true, force: true });

  const migratorRaceHome = mkdtempSync(join(tmpdir(), "oo-harness-migrator-race-"));
  const migratorRacePaths = ownerOperatorPaths(migratorRaceHome);
  mkdirSync(migratorRacePaths.workspace, { recursive: true });
  const migratorRaceLegacy = join(migratorRacePaths.workspace, "harness-roster.md");
  writeFileSync(migratorRaceLegacy, legacyBytes);
  const migratorRace = resolveUserHarnessPreferences(migratorRaceHome, {
    linkSync(oldPath, newPath) {
      fsLinkSync(oldPath, newPath);
      fsUnlinkSync(oldPath);
      fsLinkSync(oldPath, newPath);
    },
  });
  assert.equal(migratorRace.path, migratorRacePaths.userHarnessPreferences);
  assert.equal(migratorRace.source, "user-harness-preferences");
  assert.equal(migratorRace.error, null);
  assert.deepEqual(readFileSync(migratorRacePaths.userHarnessPreferences), legacyBytes,
    "the canonical bytes from another winning migrator are re-resolved and retained");
  assert.equal(existsSync(migratorRaceLegacy), false);
  rmSync(migratorRaceHome, { recursive: true, force: true });

  const failedMoveHome = mkdtempSync(join(tmpdir(), "oo-harness-failed-move-"));
  const failedMovePaths = ownerOperatorPaths(failedMoveHome);
  mkdirSync(failedMovePaths.workspace, { recursive: true });
  const failedMoveLegacy = join(failedMovePaths.workspace, "harness-roster.md");
  writeFileSync(failedMoveLegacy, legacyBytes);
  const fallback = resolveUserHarnessPreferences(failedMoveHome, {
    linkSync() { throw new Error("forced move failure"); },
  });
  assert.equal(fallback.path, failedMoveLegacy);
  assert.equal(fallback.source, "legacy-harness-roster");
  assert.match(fallback.error ?? "", /forced move failure.*using the legacy file/i);
  assert.deepEqual(readFileSync(failedMoveLegacy), legacyBytes, "move failure leaves legacy bytes untouched");
  assert.equal(existsSync(failedMovePaths.userHarnessPreferences), false);
  rmSync(failedMoveHome, { recursive: true, force: true });

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

  process.stdout.write("ok — harness: byte-preserving preference migration and permissive settings\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

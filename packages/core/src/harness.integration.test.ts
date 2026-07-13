import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GATE_POLICY,
  DEFAULT_SKILL_POLICY,
  DEFAULT_TOOL_POSTURE,
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

  ensureOwnerOperatorWorkspace(ooHome);
  assert.ok(existsSync(paths.workspaceInstructions), "workspace AGENTS.md is seeded");
  assert.ok(existsSync(paths.workspaceMemory), "workspace MEMORY.md is seeded");
  assert.ok(existsSync(paths.workspaceSkills), "workspace skills directory exists");
  assert.ok(existsSync(paths.workspaceArtifacts), "workspace artifacts directory exists");
  assert.ok(existsSync(paths.piAgentDir), "owned Pi config directory exists");

  writeFileSync(paths.workspaceInstructions, "Owner instructions stay mine.\n");
  ensureOwnerOperatorWorkspace(ooHome);
  assert.equal(
    readFileSync(paths.workspaceInstructions, "utf8"),
    "Owner instructions stay mine.\n",
    "re-entry never overwrites owner-edited bootstrap files",
  );

  const defaults = loadHarnessSettings(ooHome);
  assert.deepEqual(defaults.skillPolicy, DEFAULT_SKILL_POLICY);
  assert.deepEqual(defaults.toolPosture, DEFAULT_TOOL_POSTURE);
  assert.deepEqual(defaults.gatePolicy, DEFAULT_GATE_POLICY);

  saveHarnessSettings(ooHome, {
    activeWindow: "36h",
    skillPolicy: { mode: "allowlist", allowlist: ["calendar", "calendar", " mail "] },
  });
  const configured = loadHarnessSettings(ooHome);
  assert.equal(configured.activeWindow, "36h");
  assert.deepEqual(configured.skillPolicy, { mode: "allowlist", allowlist: ["calendar", "mail"] });
  assert.deepEqual(configured.gatePolicy, DEFAULT_GATE_POLICY, "partial updates retain safe defaults");

  saveHarnessSettings(ooHome, {
    gatePolicy: {
      interactive: { edit: "allow", write: "deny", riskyBash: "deny" },
      headless: { edit: "allow", write: "ask", riskyBash: "ask" },
    },
  });
  const patchedGate = saveHarnessSettings(ooHome, { gatePolicy: { interactive: { edit: "ask" } } });
  assert.deepEqual(patchedGate.gatePolicy, {
    interactive: { edit: "ask", write: "deny", riskyBash: "deny" },
    headless: { edit: "allow", write: "ask", riskyBash: "ask" },
  }, "partial gate updates preserve sibling operations and the untouched surface");

  process.stdout.write("ok — harness: owned paths, missing-only workspace, least-permissive settings\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

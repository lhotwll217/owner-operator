import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSessionRoot,
  disableSessionSource,
  ensureOwnerOperatorWorkspace,
  KNOWN_SESSION_SOURCES,
  markOnboarded,
  saveHarnessSettings,
} from "@owner-operator/core";
import { formatHarnessDoctor } from "./doctor";

const ooHome = mkdtempSync(join(tmpdir(), "oo-doctor-"));
try {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  for (const source of KNOWN_SESSION_SOURCES) disableSessionSource(ooHome, source);
  addSessionRoot(ooHome, "codex", "/sessions/codex");
  saveHarnessSettings(ooHome, { skillPolicy: { mode: "allowlist", allowlist: ["calendar"] } });
  writeFileSync(paths.piAuth, JSON.stringify({ codex: { type: "api_key", key: "hidden" } }), { mode: 0o600 });
  writeFileSync(paths.piSettings, JSON.stringify({ defaultProvider: "codex", defaultModel: "gpt-test" }));
  writeFileSync(paths.imports, JSON.stringify({ pi: { source: "/home/me/.pi/agent" } }));
  mkdirSync("/tmp", { recursive: true });
  markOnboarded(ooHome);

  const output = formatHarnessDoctor({
    ooHome,
    taskCwd: "/tmp/task",
    installRoot: "/opt/owner-operator",
    personalSkillsRoot: "/home/me/.agents/skills",
  });
  assert.match(output, /Status: ready/);
  assert.match(output, new RegExp(`Harness home: ${ooHome}`));
  assert.match(output, new RegExp(`Workspace: ${paths.workspace}`));
  assert.match(output, /Task cwd: \/tmp\/task/);
  assert.match(output, new RegExp(`Context: ${paths.workspaceInstructions}`));
  assert.match(output, /bundled.*\/opt\/owner-operator\/src\/agent\/skills/);
  assert.match(output, /workspace.*workspace\/skills/);
  assert.match(output, /personal allowlist.*calendar/);
  assert.match(output, /Credentials: .*auth\.json \(1 provider; imported from \/home\/me\/\.pi\/agent\)/);
  assert.doesNotMatch(output, /hidden/, "doctor never prints credential values");
  assert.match(output, /Model: codex\/gpt-test/);
  assert.match(output, /Session roots: codex=\/sessions\/codex/);
  assert.match(output, /Interactive gates: edit=ask, write=ask, risky bash=ask/);
  assert.match(output, /Headless gates: edit=deny, write=deny, risky bash=deny/);

  process.stdout.write("ok — doctor reports effective harness boundaries without credential values\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

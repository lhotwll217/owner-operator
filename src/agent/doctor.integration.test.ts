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
  saveSessionHostRoots,
  saveHarnessSettings,
  savePermissionMode,
} from "@owner-operator/core";
import { formatHarnessDoctor } from "./doctor";

const ooHome = mkdtempSync(join(tmpdir(), "oo-doctor-"));
try {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const userHome = join(ooHome, "user-home");
  const conductorDefault = join(userHome, "conductor", "workspaces");
  const existingHostRoot = join(ooHome, "superset-worktrees");
  mkdirSync(conductorDefault, { recursive: true });
  mkdirSync(existingHostRoot, { recursive: true });
  for (const source of KNOWN_SESSION_SOURCES) disableSessionSource(ooHome, source);
  addSessionRoot(ooHome, "codex", "/sessions/codex");
  saveSessionHostRoots(ooHome, [
    { host: "superset", root: existingHostRoot },
    { host: "conductor", root: "/missing/conductor-workspaces" },
  ]);
  saveHarnessSettings(ooHome, { skillPolicy: { mode: "allowlist", allowlist: ["calendar"] } });
  savePermissionMode(ooHome, "ask");
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
    userHome,
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
  assert.match(output, /Transcript stores: codex=\/sessions\/codex/);
  assert.match(output, new RegExp(`Session host roots: .*Superset App=${existingHostRoot}`));
  assert.match(output, new RegExp(`Session host roots: .*Conductor=${conductorDefault}`));
  assert.doesNotMatch(output, /missing\/conductor-workspaces/, "doctor omits host roots that do not exist");
  assert.match(output, /Permission mode: ask before shell commands and changes/);
  assert.match(output, new RegExp(`Permission config: ${paths.piPermissionConfig}`));

  process.stdout.write("ok — doctor reports effective harness boundaries without credential values\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

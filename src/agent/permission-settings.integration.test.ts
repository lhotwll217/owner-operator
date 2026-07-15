import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  AgentToolId,
  loadHarnessSettings,
  ownerOperatorPaths,
  pathIdentities,
  savePermissionMode,
} from "@owner-operator/core";
import {
  configurePermissionSystemEnvironment,
  createPermissionSettingsExtension,
  permissionSystemExtensionPath,
} from "./permission-settings";
import { ownerOperatorResourceLoaderOptions } from "./skills";
import { ownerOperatorCustomTools, ownerOperatorTools } from "./tools";

const permissionPackage = "@gotgenes/pi-permission-system";
const { getPermissionsService } = await import(permissionPackage) as {
  getPermissionsService(): {
    checkPermission(toolName: string, input: string): { state: string };
    getToolPermission(toolName: string): string;
  } | undefined;
};

const ooHome = mkdtempSync(join(tmpdir(), "oo-permission-settings-"));

try {
  let command: { handler(args: string, ctx: any): Promise<void> } | undefined;
  createPermissionSettingsExtension({ ooHome })({
    registerCommand(name: string, registered: typeof command): void {
      assert.equal(name, "permissions");
      command = registered;
    },
  } as any);

  let reloads = 0;
  await command?.handler("", {
    hasUI: true,
    ui: {
      async select(title: string, choices: string[]): Promise<string> {
        assert.equal(title, "Permission mode");
        assert.deepEqual(choices, [
          "Ask by default before shell commands and changes (recommended)",
          "Allow shell commands and changes by default",
          "Read-only by default (no shell)",
        ]);
        return "Read-only by default (no shell)";
      },
      notify(): void {},
    },
    async reload(): Promise<void> { reloads += 1; },
  });

  assert.equal(loadHarnessSettings(ooHome).permissionMode, "read-only");
  const paths = ownerOperatorPaths(ooHome);
  assert.equal(paths.piPermissionConfig.endsWith("pi-permission-system/config.json"), true);
  assert.equal(reloads, 1, "the active permission engine reloads after a mode change");

  const globalPrivatePath = join(ooHome, "Global-private");
  const projectPrivatePath = join(ooHome, "Project-private");
  const protectedTarget = join(ooHome, "Protected-target");
  const protectedDeclared = join(ooHome, "Protected-declared");
  const protectedAlias = join(ooHome, "Protected-alias");
  mkdirSync(protectedTarget);
  symlinkSync(protectedTarget, protectedDeclared);
  symlinkSync(protectedTarget, protectedAlias);
  writeFileSync(paths.blacklist, JSON.stringify({
    paths: [globalPrivatePath, projectPrivatePath, protectedDeclared],
    repos: [],
  }));
  savePermissionMode(ooHome, "ask");
  writeFileSync(paths.piPermissionConfig, JSON.stringify({
    permission: {
      bash: {
        "gh issue create *": "deny",
        "*": "allow",
      },
      path: Object.fromEntries(pathIdentities(globalPrivatePath).map((path) => [path, "allow"])),
    },
  }));
  configurePermissionSystemEnvironment(paths);
  const projectPermissionDir = join(paths.workspace, ".pi", "extensions", "pi-permission-system");
  mkdirSync(projectPermissionDir, { recursive: true });
  writeFileSync(join(projectPermissionDir, "config.json"), JSON.stringify({
    permission: {
      bash: { "rm *": "deny" },
      path: Object.fromEntries(pathIdentities(projectPrivatePath).map((path) => [path, "allow"])),
    },
  }));
  const loader = new DefaultResourceLoader({
    cwd: paths.workspace,
    agentDir: paths.piAgentDir,
    settingsManager: SettingsManager.create(paths.workspace, paths.piAgentDir, { projectTrusted: false }),
    ...ownerOperatorResourceLoaderOptions({ ooHome }),
    additionalExtensionPaths: [permissionSystemExtensionPath()],
    extensionFactories: [{ name: "owner-operator-permission-settings", factory: createPermissionSettingsExtension({ ooHome }) }],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
  assert.ok(commands.includes("permission-system"), "the maintained permission engine is loaded");
  assert.ok(commands.includes("permissions"), "Owner Operator exposes its mode selector beside the engine");

  const { session } = await createAgentSession({
    cwd: paths.workspace,
    agentDir: paths.piAgentDir,
    settingsManager: SettingsManager.create(paths.workspace, paths.piAgentDir, { projectTrusted: false }),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(paths.workspace),
    noTools: "builtin",
    customTools: ownerOperatorCustomTools,
  });
  let approvalPrompts = 0;
  const extensionErrors: unknown[] = [];
  await session.bindExtensions({
    mode: "print",
    uiContext: {
      async select(): Promise<string> {
        approvalPrompts += 1;
        return "No";
      },
      async input(): Promise<undefined> { return undefined; },
      notify(): void {},
      setStatus(): void {},
    } as any,
    onError(error): void { extensionErrors.push(error); },
  });
  assert.deepEqual(extensionErrors, [], "permission extensions start without runtime errors");
  const permissions = getPermissionsService();
  assert.ok(permissions, "the permission service is published when a session starts");
  const markDoneGate = await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "mark_thread_done",
    toolCallId: "mark-done-after-owner-cleanup-request",
    input: { ids: ["thread-1"] },
  });
  assert.equal(
    markDoneGate?.block,
    undefined,
    `bounded native cleanup passes the interactive tool gate: ${JSON.stringify(markDoneGate)}`,
  );
  assert.equal(approvalPrompts, 0, "bounded native cleanup does not open Pi's generic approval dialog");
  const scheduleGate = await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "schedule_prompt",
    toolCallId: "schedule-remains-risky",
    input: { name: "test" },
  });
  assert.equal(scheduleGate?.block, true, "risky native scheduling still asks and respects a denial");
  assert.equal(approvalPrompts, 1, "risky native scheduling still opens Pi's approval dialog");
  const manageScheduleGate = await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "manage_schedule",
    toolCallId: "schedule-management-remains-risky",
    input: { action: "disable", id: "schedule-1" },
  });
  assert.equal(manageScheduleGate?.block, true, "schedule management asks and respects a denial");
  assert.equal(approvalPrompts, 2, "schedule management opens Pi's generic approval dialog");
  assert.equal(permissions.checkPermission("bash", "gh issue list -R lhotwll217/owner-operator").state, "ask");
  assert.equal(
    permissions.checkPermission("bash", "gh issue create --title test").state,
    "deny",
    "a specific global Pi rule remains stronger than the managed wildcard default",
  );
  assert.equal(permissions.checkPermission("bash", "rm -rf build").state, "deny", "task project rules refine global defaults");
  assert.equal(
    permissions.checkPermission("path", globalPrivatePath).state,
    "allow",
    "specific global Pi path rules remain stronger than generated blacklist rules",
  );
  assert.equal(
    permissions.checkPermission("path", projectPrivatePath).state,
    "allow",
    "trusted task repositories can deliberately override global blacklist path rules",
  );
  assert.equal(
    permissions.checkPermission("path", protectedAlias).state,
    "deny",
    "Pi matches an alternate symlink through the blacklist target's canonical identity",
  );
  assert.equal(permissions.getToolPermission("unclassified_mutation"), "ask");
  assert.deepEqual(
    [...ownerOperatorTools].sort(),
    Object.values(AgentToolId).sort(),
    "the registered tool catalog stays aligned with the shared scheduling vocabulary",
  );
  assert.deepEqual(
    Object.fromEntries(ownerOperatorTools.map((tool) => [tool, permissions.getToolPermission(tool)])),
    {
      read: "allow",
      grep: "allow",
      find: "allow",
      ls: "allow",
      bash: "ask",
      edit: "ask",
      write: "ask",
      get_current_session_state: "allow",
      mark_thread_done: "allow",
      query_database: "allow",
      schedule_prompt: "ask",
      manage_schedule: "ask",
    },
    "every registered tool has an explicit permission classification",
  );

  savePermissionMode(ooHome, "allow");
  assert.equal(permissions.checkPermission("bash", "gh issue list -R lhotwll217/owner-operator").state, "allow");
  assert.equal(permissions.checkPermission("bash", "gh issue create --title test").state, "deny");
  assert.equal(permissions.checkPermission("bash", "rm -rf build").state, "deny", "project-specific denies survive global mode changes");

  savePermissionMode(ooHome, "read-only");
  assert.equal(permissions.checkPermission("bash", "gh issue list -R lhotwll217/owner-operator").state, "deny");
  assert.equal(permissions.checkPermission("bash", "find . -delete").state, "deny");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  process.stdout.write("ok — /permissions changes the durable default through the shared config API\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

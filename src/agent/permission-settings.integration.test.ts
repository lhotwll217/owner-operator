import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadHarnessSettings, ownerOperatorPaths, savePermissionMode } from "@owner-operator/core";
import {
  configurePermissionSystemEnvironment,
  createPermissionSettingsExtension,
  permissionSystemExtensionPath,
} from "./permission-settings";
import { ownerOperatorResourceLoaderOptions } from "./skills";

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
        assert.equal(title, "Default permissions");
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

  const privatePath = join(ooHome, "Private");
  writeFileSync(paths.blacklist, JSON.stringify({ paths: [privatePath], repos: [] }));
  savePermissionMode(ooHome, "ask");
  configurePermissionSystemEnvironment(paths);
  const projectPermissionDir = join(paths.workspace, ".pi", "extensions", "pi-permission-system");
  mkdirSync(projectPermissionDir, { recursive: true });
  writeFileSync(join(projectPermissionDir, "config.json"), JSON.stringify({
    permission: { bash: { "rm *": "deny" } },
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
    noTools: "all",
  });
  await session.bindExtensions({});
  const permissions = getPermissionsService();
  assert.ok(permissions, "the permission service is published when a session starts");
  assert.equal(permissions.checkPermission("bash", "gh issue list -R lhotwll217/owner-operator").state, "ask");
  assert.equal(permissions.checkPermission("bash", "gh issue create --title test").state, "ask");
  assert.equal(permissions.checkPermission("bash", "rm -rf build").state, "deny", "task project rules refine global defaults");
  assert.equal(permissions.checkPermission("path", privatePath).state, "deny");
  assert.equal(permissions.getToolPermission("unclassified_mutation"), "ask");
  assert.equal(permissions.getToolPermission("read"), "allow");
  assert.equal(permissions.getToolPermission("get_current_session_state"), "allow");
  assert.equal(permissions.getToolPermission("schedule_prompt"), "ask");
  assert.equal(permissions.getToolPermission("edit"), "ask");

  savePermissionMode(ooHome, "allow");
  assert.equal(permissions.checkPermission("bash", "gh issue list -R lhotwll217/owner-operator").state, "allow");
  assert.equal(permissions.checkPermission("bash", "rm -rf build").state, "deny", "project-specific denies survive global mode changes");

  savePermissionMode(ooHome, "read-only");
  assert.equal(permissions.checkPermission("bash", "gh issue list -R lhotwll217/owner-operator").state, "deny");
  assert.equal(permissions.checkPermission("bash", "find . -delete").state, "deny");
  session.dispose();
  process.stdout.write("ok — /permissions changes the durable default through the shared config API\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

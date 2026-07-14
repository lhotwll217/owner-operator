import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reconcilePermissionSettings,
  savePermissionMode,
  type OwnerOperatorPaths,
  type PermissionMode,
} from "@owner-operator/core";

export const PERMISSION_MODE_CHOICES = [
  "Ask by default before shell commands and changes (recommended)",
  "Allow shell commands and changes by default",
  "Read-only by default (no shell)",
] as const;

export const permissionModeForChoice = (choice: string): PermissionMode =>
  choice === "Allow shell commands and changes by default"
    ? "allow"
    : choice === "Read-only by default (no shell)" ? "read-only" : "ask";

export const permissionSystemExtensionPath = (): string =>
  join(dirname(fileURLToPath(import.meta.resolve("@gotgenes/pi-permission-system"))), "index.ts");

export function configurePermissionSystemEnvironment(paths: OwnerOperatorPaths): void {
  process.env.PI_CODING_AGENT_DIR = paths.piAgentDir;
  reconcilePermissionSettings(paths.home);
}

export function createPermissionSettingsExtension(options: { ooHome?: string } = {}): ExtensionFactory {
  return (pi) => {
    pi.registerCommand("permissions", {
      description: "Change Owner Operator's default permission mode.",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("/permissions requires interactive mode.", "warning");
          return;
        }
        const choice = await ctx.ui.select("Default permissions", [...PERMISSION_MODE_CHOICES]);
        if (!choice) return;
        const mode = permissionModeForChoice(choice);
        savePermissionMode(options.ooHome, mode);
        ctx.ui.notify(`Default permissions: ${choice.replace(" (recommended)", "")}.`, "info");
        await ctx.reload();
      },
    });
  };
}

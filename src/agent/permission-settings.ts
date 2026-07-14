import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const permissionPackage = "@gotgenes/pi-permission-system";

export function permissionSystemExtensionPath(): string {
  let directory = dirname(fileURLToPath(import.meta.resolve(permissionPackage)));
  for (;;) {
    let manifest: { name?: string; pi?: { extensions?: unknown[] } } | undefined;
    try {
      manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (manifest?.name === permissionPackage) {
      const extension = manifest.pi?.extensions?.find((entry): entry is string => typeof entry === "string");
      if (!extension) throw new Error(`${permissionPackage} does not declare a Pi extension`);
      return resolve(directory, extension);
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot locate ${permissionPackage} package manifest`);
    directory = parent;
  }
}

export function configurePermissionSystemEnvironment(paths: OwnerOperatorPaths): void {
  process.env.PI_CODING_AGENT_DIR = paths.piAgentDir;
  reconcilePermissionSettings(paths.home);
}

export function createPermissionSettingsExtension(options: { ooHome?: string } = {}): ExtensionFactory {
  return (pi) => {
    pi.registerCommand("permissions", {
      description: "Change Owner Operator's permission mode.",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("/permissions requires interactive mode.", "warning");
          return;
        }
        const choice = await ctx.ui.select("Permission mode", [...PERMISSION_MODE_CHOICES]);
        if (!choice) return;
        const mode = permissionModeForChoice(choice);
        savePermissionMode(options.ooHome, mode);
        ctx.ui.notify(`Permission mode: ${choice.replace(" (recommended)", "")}.`, "info");
        await ctx.reload();
      },
    });
  };
}

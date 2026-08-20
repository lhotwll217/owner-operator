import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  importPiConfiguration,
  markOnboarded,
  ownerOperatorPaths,
  savePermissionMode,
} from "@owner-operator/core";
import { evalSandboxUserPaths, sanitizeEvalDiagnosticValue } from "./sandbox.mjs";

interface ModelSettings {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel?: string;
  transport?: string;
}

export function createEvalSandboxUserEnvironment(options: {
  root: string;
  sourcePiAgentDir: string;
  protectedOwnerPaths?: string[];
  modelSettings: ModelSettings;
}) {
  const protectedOwnerPaths = options.protectedOwnerPaths ?? [];
  const sandbox = evalSandboxUserPaths(options.root);
  const unexpected = existsSync(sandbox.root)
    ? readdirSync(sandbox.root).filter((name) => name !== "task" && name !== "tmp")
    : [];
  if (unexpected.length) throw new Error(`eval sandbox user root is not pristine: ${unexpected.join(", ")}`);
  mkdirSync(sandbox.taskCwd, { recursive: true });
  mkdirSync(sandbox.tempDir, { recursive: true });
  const paths = ownerOperatorPaths(sandbox.ooHome);
  importPiConfiguration(sandbox.ooHome, options.sourcePiAgentDir);
  const importedSettings = readJson(paths.piSettings);
  writeFileSync(paths.piSettings, `${JSON.stringify({
    ...importedSettings,
    defaultProvider: options.modelSettings.defaultProvider,
    defaultModel: options.modelSettings.defaultModel,
    ...(options.modelSettings.defaultThinkingLevel
      ? { defaultThinkingLevel: options.modelSettings.defaultThinkingLevel }
      : {}),
    transport: options.modelSettings.transport ?? "sse",
  }, null, 2)}\n`);
  if (existsSync(paths.piAuth)) chmodSync(paths.piAuth, 0o600);
  writeFileSync(paths.sessionSources, `${JSON.stringify({
    disable: ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"],
    add: [],
  }, null, 2)}\n`);
  writeFileSync(paths.blacklist, `${JSON.stringify({
    paths: [...new Set(protectedOwnerPaths.map((value) => resolve(value)))],
    repos: [],
  }, null, 2)}\n`);
  markOnboarded(sandbox.ooHome, { via: "eval-sandbox-user" });
  savePermissionMode(sandbox.ooHome, "ask");

  return {
    ...sandbox,
    finalize({ teardownVerified, diagnostic = {} }: {
      teardownVerified: boolean;
      diagnostic?: Record<string, unknown>;
    }): string | null {
      for (const file of [paths.piAuth, paths.piSettings, paths.piModels]) rmSync(file, { force: true });
      if (teardownVerified) {
        rmSync(sandbox.root, { recursive: true, force: true });
        return null;
      }
      const redactions = [options.sourcePiAgentDir, ...protectedOwnerPaths, sandbox.userHome, sandbox.ooHome]
        .map((value) => resolve(value));
      const safeDiagnostic = sanitizeEvalDiagnosticValue(diagnostic, redactions);
      rmSync(sandbox.root, { recursive: true, force: true });
      const preserved = `${sandbox.root}/diagnostics`;
      mkdirSync(preserved, { recursive: true });
      writeFileSync(`${preserved}/diagnostic.json`, `${JSON.stringify(safeDiagnostic, null, 2)}\n`);
      return preserved;
    },
  };
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

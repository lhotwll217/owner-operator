import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  ensureOwnerOperatorWorkspace,
  loadHarnessSettings,
} from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

export interface OwnerOperatorResourceOptions {
  ooHome?: string;
  personalSkillsRoot?: string;
}

type ResourceOptions = Omit<ConstructorParameters<typeof DefaultResourceLoader>[0], "cwd" | "agentDir">;

/** Disable every ambient Pi resource channel, then add only Owner Operator-owned resources. */
export function ownerOperatorResourceLoaderOptions(
  options: OwnerOperatorResourceOptions = {},
): ResourceOptions {
  const paths = ensureOwnerOperatorWorkspace(options.ooHome);
  const settings = loadHarnessSettings(paths.home);
  const personalRoot = options.personalSkillsRoot ?? join(homedir(), ".agents", "skills");
  const personalPaths = settings.skillPolicy.mode === "all-personal"
    ? [personalRoot]
    : settings.skillPolicy.mode === "allowlist"
      ? settings.skillPolicy.allowlist
          .filter((name) => /^[A-Za-z0-9._-]+$/.test(name))
          .map((name) => join(personalRoot, name))
          .filter(existsSync)
      : [];
  return {
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: [
      join(repoRoot, "src", "agent", "skills"),
      paths.workspaceSkills,
      ...personalPaths,
    ],
    agentsFilesOverride: () => ({
      agentsFiles: existsSync(paths.workspaceInstructions)
        ? [{ path: paths.workspaceInstructions, content: readFileSync(paths.workspaceInstructions, "utf8") }]
        : [],
    }),
  };
}

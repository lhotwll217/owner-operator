export type SkillPolicy =
  | { mode: "owner-operator"; allowlist: [] }
  | { mode: "all-personal"; allowlist: [] }
  | { mode: "allowlist"; allowlist: string[] };

export type PermissionMode = "ask" | "allow" | "read-only";
export interface HarnessSettings {
  activeWindow: string;
  skillPolicy: SkillPolicy;
  toolPosture: string[];
  permissionMode: PermissionMode;
  alwaysOn?: "installed" | "declined";
}
export interface OwnerOperatorPaths {
  home: string;
  workspace: string;
  workspaceInstructions: string;
  workspaceMemory: string;
  workspaceSkills: string;
  workspaceArtifacts: string;
  piAgentDir: string;
  piAuth: string;
  piSettings: string;
  piModels: string;
  piPermissionConfig: string;
  imports: string;
  settings: string;
  onboardingMarker: string;
  blacklist: string;
  sessionSources: string;
  sessionHosts: string;
}

export const DEFAULT_SKILL_POLICY: Readonly<SkillPolicy>;
export const DEFAULT_TOOL_POSTURE: readonly string[];
export const DEFAULT_PERMISSION_MODE: PermissionMode;
export function isPermissionMode(value: unknown): value is PermissionMode;
export function ownerOperatorPaths(ooHome?: string): OwnerOperatorPaths;
export function ensureOwnerOperatorWorkspace(ooHome?: string): OwnerOperatorPaths;
export function loadHarnessSettings(ooHome?: string): HarnessSettings;
export function saveHarnessSettings(
  ooHome: string | undefined,
  patch?: Partial<HarnessSettings>,
): HarnessSettings;

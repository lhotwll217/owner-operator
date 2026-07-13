export type SkillPolicy =
  | { mode: "owner-operator"; allowlist: [] }
  | { mode: "all-personal"; allowlist: [] }
  | { mode: "allowlist"; allowlist: string[] };

export type GateAction = "allow" | "ask" | "deny";
export interface GateSurfacePolicy {
  edit: GateAction;
  write: GateAction;
  riskyBash: GateAction;
}
export interface GatePolicy {
  interactive: GateSurfacePolicy;
  headless: GateSurfacePolicy;
}
export interface GatePolicyPatch {
  interactive?: Partial<GateSurfacePolicy>;
  headless?: Partial<GateSurfacePolicy>;
}
export interface HarnessSettings {
  activeWindow: string;
  skillPolicy: SkillPolicy;
  toolPosture: string[];
  gatePolicy: GatePolicy;
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
  imports: string;
  settings: string;
  onboardingMarker: string;
  blacklist: string;
  sessionSources: string;
  sessionHosts: string;
}

export const DEFAULT_SKILL_POLICY: Readonly<SkillPolicy>;
export const DEFAULT_TOOL_POSTURE: readonly string[];
export const DEFAULT_GATE_POLICY: Readonly<GatePolicy>;
export function ownerOperatorPaths(ooHome?: string): OwnerOperatorPaths;
export function ensureOwnerOperatorWorkspace(ooHome?: string): OwnerOperatorPaths;
export function loadHarnessSettings(ooHome?: string): HarnessSettings;
export function saveHarnessSettings(
  ooHome: string | undefined,
  patch?: Omit<Partial<HarnessSettings>, "gatePolicy"> & { gatePolicy?: GatePolicyPatch },
): HarnessSettings;

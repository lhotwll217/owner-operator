import type { AgentHarnessId, TranscriptFormat } from "./session-sources.mjs";

export type SessionHostId =
  | "superset"
  | "conductor"
  | "posthog-code"
  | "claude-app"
  | "claude-sdk"
  | "claude-cli"
  | "codex-app"
  | "codex-sdk"
  | "codex-cli"
  | "cursor"
  | "pi"
  | "opencode"
  | "antigravity"
  | "grok-build";

export interface SessionHostDescriptor {
  id: SessionHostId;
  label: string;
  review: boolean;
  harnesses: readonly AgentHarnessId[];
  defaultRoots?: readonly (readonly string[])[];
  formats?: readonly TranscriptFormat[];
  entrypoints?: readonly string[];
  originators?: readonly string[];
  sourceHints?: readonly string[];
  appNames?: readonly string[];
  commands?: readonly string[];
  formatMatch?: boolean;
  automatedTransport?: boolean;
  fallback?: boolean;
  overridesAutomation?: boolean;
  surfaceEmpty?: boolean;
}

export interface SessionHost extends Omit<SessionHostDescriptor, "id"> {
  id: SessionHostId | string;
  roots: readonly string[];
  cwdMarkers?: readonly string[];
}

export interface SessionIdentity {
  format: string;
  cwd?: string | null;
  entrypoint?: string | null;
  originator?: string | null;
  sourceHint?: string | null;
}

export const SESSION_HOST_DESCRIPTORS: readonly SessionHostDescriptor[];
export const KNOWN_SESSION_HOSTS: readonly SessionHostId[];
export const REVIEWED_SESSION_HOSTS: readonly SessionHostId[];
export function loadSessionHosts(ooHome?: string, options?: { home?: string }): SessionHost[];
export function sessionHostForCwd(cwd: string | null | undefined, hosts?: SessionHost[]): SessionHost | null;
export function sessionHostFor(session: SessionIdentity, hosts?: SessionHost[]): SessionHost | null;

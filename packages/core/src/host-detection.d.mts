import type { SessionHostId } from "./session-hosts.mjs";

export interface SessionHostCandidate {
  host: SessionHostId | string;
  root?: string;
  path?: string;
  exists: boolean;
  origin: "catalog" | "superset-home" | "superset-settings" | "app" | "command";
}

export function detectSessionHostCandidates(
  ooHome?: string,
  options?: { home?: string; env?: Record<string, string | undefined>; applications?: string[] },
): Promise<SessionHostCandidate[]>;

import type { PermissionMode } from "./harness.mjs";

export type PiPermissionState = "allow" | "ask" | "deny";
export interface PiDenyRule {
  action: "deny";
  reason?: string;
}
export type PiPermissionPatternMap = Record<string, PiPermissionState | PiDenyRule>;
export interface PiPermissionConfig {
  permission: Record<string, PiPermissionState | PiPermissionPatternMap>;
  [key: string]: unknown;
}

export function reconcilePermissionSettings(ooHome?: string): PiPermissionConfig;
export function savePermissionMode(ooHome: string | undefined, mode: PermissionMode): PiPermissionConfig;

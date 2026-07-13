// Hand-written declarations for onboarding.mjs (plain ESM so the scan skill can import it
// without a build step). Keep in lockstep with onboarding.mjs.

import type { Blacklist } from "./blacklist.d.mts";
import type { SessionSource, TranscriptFormat } from "./session-sources.d.mts";
import type { SessionHostId } from "./session-hosts.d.mts";

/** Bumped when the flow gains a step the owner must be re-walked through. */
export const ONBOARDING_VERSION: number;
export type OnboardingStep = "intro" | "privacy" | "auth" | "session-sources" | "active-window" | "skills" | "always-on";
export const ONBOARDING_STEPS: readonly OnboardingStep[];

/** One configured (source, root) probed for existing sessions. */
export interface DetectedRoot {
  source: SessionSource;
  root: string;
  /** The root directory exists on disk. */
  exists: boolean;
  /** Approximate session-file count under the root (bounded walk; a rough activity signal). */
  count: number;
}

/** Per-source rollup of DetectedRoot rows (a source may have several roots). */
export interface DetectedSource {
  source: SessionSource;
  roots: string[];
  exists: boolean;
  count: number;
}

/** True once every current consent step is complete at the current marker version. */
export function isOnboarded(ooHome?: string): boolean;
export function pendingOnboardingSteps(ooHome?: string): OnboardingStep[];
export function markOnboardingStep(
  ooHome: string | undefined,
  step: OnboardingStep,
  extra?: Record<string, unknown>,
): Record<string, unknown>;

/** Record that onboarding finished — version + timestamp, plus any provenance passed in. */
export function markOnboarded(ooHome?: string, extra?: Record<string, unknown>): Record<string, unknown>;
export function loadPiImportDecision(ooHome?: string): "imported" | "declined" | null;
export function recordPiImportDecision(
  ooHome: string | undefined,
  decision: "imported" | "declined",
): "imported" | "declined";

export interface PiConfigurationDetection {
  auth: boolean;
  settings: boolean;
  models: boolean;
  selectedModel: boolean;
  selectedModelAuthorized: boolean;
}
export function detectPiConfiguration(piAgentDir: string): PiConfigurationDetection;
export function importPiConfiguration(
  ooHome: string | undefined,
  piAgentDir: string,
): PiConfigurationDetection & { source: string };

/** Add off-limits paths/repos to <ooHome>/blacklist.json, merged and de-duped. Returns the result. */
export function addBlacklistEntries(ooHome?: string, entries?: { paths?: string[]; repos?: string[] }): Blacklist;

/** Point a known source at an extra root in session_sources.json `add`. Throws on unknown source. */
export function addSessionRoot(ooHome: string | undefined, source: string, root: string): { source: SessionSource; root: string };

/** Replace the scan aperture with exactly the roots confirmed during setup. */
export function saveSessionRoots(
  ooHome: string | undefined,
  roots: readonly { source: string; root: string }[],
): Array<{ source: SessionSource; root: string }>;

export function saveTranscriptAccess(
  ooHome: string | undefined,
  selectedFormats: readonly string[],
  roots?: readonly { format?: string; source?: string; root: string }[],
  defaultFormats?: readonly string[],
): { selected: TranscriptFormat[]; add: Array<{ source: TranscriptFormat; root: string }> };

export function saveSessionHostRoots(
  ooHome: string | undefined,
  roots: readonly { host: string; root: string }[],
): Array<{ host: SessionHostId; root: string }>;

/** Skip a default source's roots via session_sources.json `disable`. Returns the merged list. */
export function disableSessionSource(ooHome: string | undefined, source: string): string[];

/** Set the active-thread window in settings.json (validated). Throws on an unparseable spec. */
export function saveActiveWindow(ooHome: string | undefined, spec: string): string;

/** Probe every configured (source, root) for existing sessions — the pre-scan detection data. */
export function detectSources(ooHome?: string, opts?: { cap?: number; maxDepth?: number }): DetectedRoot[];

/** Collapse detectSources() rows to one per source — the per-tool summary the confirm screen lists. */
export function summarizeDetectedSources(detected: DetectedRoot[]): DetectedSource[];

export interface SessionSourceCandidate {
  source: SessionSource;
  root: string;
  tier: 1 | 2 | 3;
  exists: boolean;
  shape: boolean;
}
export interface SessionSourceDetectionOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  deep?: boolean;
  maxDepth?: number;
  timeoutMs?: number;
  volumes?: string[];
}
/** Detect candidates without configuring them. Tier 3 runs only when `deep` is true. */
export function detectSessionSourceCandidates(
  ooHome?: string,
  options?: SessionSourceDetectionOptions,
): SessionSourceCandidate[];
export { detectSessionHostCandidates } from "./host-detection.mjs";
export type { SessionHostCandidate } from "./host-detection.mjs";

// Hand-written declarations for onboarding.mjs (plain ESM so the scan skill can import it
// without a build step). Keep in lockstep with onboarding.mjs.

import type { Blacklist } from "./blacklist.d.mts";
import type { SessionSource } from "./session-sources.d.mts";

/** Bumped when the flow gains a step the owner must be re-walked through. */
export const ONBOARDING_VERSION: number;

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

/** True once the guided setup has completed at least once (<ooHome>/onboarded.json present). */
export function isOnboarded(ooHome?: string): boolean;

/** Record that onboarding finished — version + timestamp, plus any provenance passed in. */
export function markOnboarded(ooHome?: string, extra?: Record<string, unknown>): Record<string, unknown>;

/** Add off-limits paths/repos to <ooHome>/blacklist.json, merged and de-duped. Returns the result. */
export function addBlacklistEntries(ooHome?: string, entries?: { paths?: string[]; repos?: string[] }): Blacklist;

/** Point a known source at an extra root in session_sources.json `add`. Throws on unknown source. */
export function addSessionRoot(ooHome: string | undefined, source: string, root: string): { source: SessionSource; root: string };

/** Skip a default source's roots via session_sources.json `disable`. Returns the merged list. */
export function disableSessionSource(ooHome: string | undefined, source: string): string[];

/** Set the active-thread window in settings.json (validated). Throws on an unparseable spec. */
export function saveActiveWindow(ooHome: string | undefined, spec: string): string;

/** Probe every configured (source, root) for existing sessions — the pre-scan detection data. */
export function detectSources(ooHome?: string, opts?: { cap?: number; maxDepth?: number }): DetectedRoot[];

/** Collapse detectSources() rows to one per source — the per-tool summary the confirm screen lists. */
export function summarizeDetectedSources(detected: DetectedRoot[]): DetectedSource[];

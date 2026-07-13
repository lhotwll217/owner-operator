// Hand-written declarations for session-sources.mjs (plain ESM so the scan skill can import
// it without a build step). Keep in lockstep with session-sources.mjs.

/** Source kinds the scan can parse — config roots are only honored for one of these. */
export type SessionSource =
  | "claude"
  | "codex"
  | "cursor"
  | "posthog-code"
  | "pi"
  | "opencode"
  | "antigravity"
  | "grok-build";

/** A directory to scan/watch, tagged with the format its files are in. */
export interface SessionRoot {
  source: SessionSource;
  root: string;
}

export interface SessionSourceDescriptor {
  source: SessionSource;
  defaults: readonly (readonly string[])[];
  common: readonly (readonly string[])[];
  declared: readonly { env: string; suffix: readonly string[] }[];
  deep: readonly { marker: string; suffix: readonly string[] }[];
}

export const KNOWN_SESSION_SOURCES: readonly SessionSource[];
export const SESSION_SOURCE_DESCRIPTORS: readonly SessionSourceDescriptor[];

/**
 * The (source, root) dirs to scan/watch: built-in defaults minus `disable`, plus `add`,
 * from <ooHome>/session_sources.json. Missing/invalid config → defaults only.
 * ooHome defaults to $OO_HOME or ~/.owner-operator.
 */
export function loadSessionSources(ooHome?: string): SessionRoot[];

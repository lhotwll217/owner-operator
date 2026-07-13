// Hand-written declarations for session-sources.mjs (plain ESM so the scan skill can import
// it without a build step). Keep in lockstep with session-sources.mjs.

/** Record shapes the transcript scanner can parse. */
export type TranscriptFormat =
  | "claude"
  | "codex"
  | "cursor"
  | "posthog-code"
  | "pi"
  | "opencode"
  | "antigravity"
  | "grok-build";
/** Compatibility name used by session_sources.json and older callers. */
export type SessionSource = TranscriptFormat;

export type AgentHarnessId =
  | "claude-code"
  | "codex"
  | "cursor-agent"
  | "posthog-code"
  | "pi"
  | "opencode"
  | "antigravity"
  | "grok-build";

export interface AgentHarnessDescriptor {
  id: AgentHarnessId;
  label: string;
  transcriptFormat: TranscriptFormat;
  defaults: readonly (readonly string[])[];
  common: readonly (readonly string[])[];
  declared: readonly { env: string; suffix: readonly string[] }[];
  deep: readonly { marker: string; suffix: readonly string[] }[];
}

export interface TranscriptStore {
  format: TranscriptFormat;
  root: string;
}

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
export const KNOWN_AGENT_HARNESSES: readonly AgentHarnessId[];
export const KNOWN_TRANSCRIPT_FORMATS: readonly TranscriptFormat[];
export const AGENT_HARNESS_DESCRIPTORS: readonly AgentHarnessDescriptor[];
export function assertTranscriptFormatCoverage(implementedFormats: Iterable<string>): void;
export function loadTranscriptStores(ooHome?: string): TranscriptStore[];
export function loadTranscriptAccess(ooHome?: string): {
  selectedFormats: TranscriptFormat[];
  defaultFormats: TranscriptFormat[];
};

/**
 * The (source, root) dirs to scan/watch: built-in defaults minus `disable`, plus `add`,
 * from <ooHome>/session_sources.json. Missing/invalid config → defaults only.
 * ooHome defaults to $OO_HOME or ~/.owner-operator.
 */
export function loadSessionSources(ooHome?: string): SessionRoot[];

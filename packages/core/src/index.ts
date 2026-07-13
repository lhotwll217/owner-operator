// Owner Operator — shared domain model.
//
// UI-INDEPENDENT by design: the gateway *produces* this data; every surface (widget,
// terminal, web, another agent, a script) *consumes* it. No colors, no layout, no terminal, no
// engine deps. This is the contract the daemon and all renderers agree on.

// The privacy blacklist: repos/paths the owner declared off-limits — enforced at the
// scan (discovery), the store seam (writes), and the open-time purge. See blacklist.mjs.
export { loadBlacklist, isBlacklisted, pathSlugs } from "./blacklist.mjs";
export type { Blacklist } from "./blacklist.mjs";

// Where local agent sessions live — the (source, root) dirs the scan and monitor share, with
// owner overrides from session_sources.json. One source of truth so they can't drift.
export {
  AGENT_HARNESS_DESCRIPTORS,
  KNOWN_AGENT_HARNESSES,
  KNOWN_SESSION_SOURCES,
  KNOWN_TRANSCRIPT_FORMATS,
  SESSION_SOURCE_DESCRIPTORS,
  assertTranscriptFormatCoverage,
  loadSessionSources,
  loadTranscriptAccess,
  loadTranscriptStores,
} from "./session-sources.mjs";
export type {
  AgentHarnessDescriptor,
  AgentHarnessId,
  SessionSource,
  SessionRoot,
  SessionSourceDescriptor,
  TranscriptFormat,
  TranscriptStore,
} from "./session-sources.mjs";

// Transcript transport context must not become a visible topic. Shared by the scanner and
// durable state projection so legacy rows follow the current classification too.
export { isSessionBoilerplate } from "./session-text.mjs";

// Interactive GUI hosts (Conductor/Superset drive the SDK, PostHog Code ACP) — the single
// source of truth that keeps a deliberately-launched session from being hidden as an SDK
// worker. Read by the scan's launch-mode classifier and app detection. See gui-hosts.mjs.
export { loadGuiHosts, guiHostForCwd, interactiveHost } from "./gui-hosts.mjs";
export type { GuiHost } from "./gui-hosts.mjs";

export {
  KNOWN_SESSION_HOSTS,
  REVIEWED_SESSION_HOSTS,
  SESSION_HOST_DESCRIPTORS,
  loadSessionHosts,
  sessionHostFor,
  sessionHostForCwd,
} from "./session-hosts.mjs";
export type { SessionHost, SessionHostDescriptor, SessionHostId, SessionIdentity } from "./session-hosts.mjs";

// Owner settings — scalar knobs (today the active-thread window) from settings.json, later set
// in onboarding. The window grammar (parseWindowMs) is shared so the scan's cutoff and the
// settings validator can't drift. See settings.mjs.
export { loadActiveWindow, parseWindowMs, isWindowSpec, DEFAULT_ACTIVE_WINDOW } from "./settings.mjs";

export {
  DEFAULT_GATE_POLICY,
  DEFAULT_SKILL_POLICY,
  DEFAULT_TOOL_POSTURE,
  ensureOwnerOperatorWorkspace,
  loadHarnessSettings,
  ownerOperatorPaths,
  saveHarnessSettings,
} from "./harness.mjs";
export type {
  GateAction,
  GatePolicy,
  GatePolicyPatch,
  GateSurfacePolicy,
  HarnessSettings,
  OwnerOperatorPaths,
  SkillPolicy,
} from "./harness.mjs";

// First-run setup's dependency-light config API: validated writers, versioned marker, and bounded
// source detection. The interactive flow is one client; scripts can call the same seam.
export {
  ONBOARDING_VERSION,
  ONBOARDING_STEPS,
  detectPiConfiguration,
  detectSessionSourceCandidates,
  detectSessionHostCandidates,
  importPiConfiguration,
  isOnboarded,
  loadPiImportDecision,
  markOnboardingStep,
  markOnboarded,
  pendingOnboardingSteps,
  addBlacklistEntries,
  addSessionRoot,
  saveSessionRoots,
  saveTranscriptAccess,
  saveSessionHostRoots,
  sessionCatalogReviewContract,
  recordPiImportDecision,
  disableSessionSource,
  saveActiveWindow,
  detectSources,
  summarizeDetectedSources,
} from "./onboarding.mjs";
export type {
  DetectedRoot,
  DetectedSource,
  OnboardingStep,
  PiConfigurationDetection,
  SessionSourceCandidate,
  SessionSourceDetectionOptions,
} from "./onboarding.mjs";
export type { SessionHostCandidate } from "./onboarding.mjs";

// Thread status & the lo-fi state machine — model-free, polled, persisted. See status.ts.
export * from "./status";

// Session-state data model: digest metadata + live status (+ cached model details), with the
// default-visible filter and grouping all surfaces share. See session-state.ts.
export * from "./session-state";

// Typed schedules, payloads, tool ids, and durable run outcomes.
export * from "./scheduling";
export * from "./events";

// The daemon wire protocol: endpoints, schedules/triggers, and push events — the contract
// every surface speaks to the one state-owning process. See protocol.ts.
export * from "./protocol";

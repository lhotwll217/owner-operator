/**
 * Browser-safe parent-turn activity contracts and policy.
 *
 * This module deliberately accepts no tool arguments, results, or provider reasoning. A
 * harness adapter may submit an explicit thinking summary or a tool name; the reducer retains
 * only the summary and labels from the allowlist below.
 */

export type TurnActivityEvent =
  | { kind: "turn_started"; turnId: string; at: number }
  | { kind: "thinking_summary"; turnId: string; eventId: string; at: number; summary: string }
  | { kind: "tool"; turnId: string; eventId: string; at: number; toolName: string }
  | {
    kind: "turn_settled";
    turnId: string;
    at: number;
    outcome: "completed" | "interrupted";
    hasResponse?: true;
  };

export interface TurnTraceAction {
  eventId: string;
  kind: "thinking_summary" | "tool";
  label: string;
}

export interface TurnTrace {
  turnId: string;
  startedAt?: number;
  settledAt?: number;
  outcome?: "completed" | "interrupted";
  hasResponse?: true;
  actions: readonly TurnTraceAction[];
  eventIds: ReadonlySet<string>;
}

export interface TurnTraceActionView {
  kind: TurnTraceAction["kind"];
  label: string;
  marker: "│" | "●";
  emphasis: "muted" | "current";
}

export type TurnTraceView =
  | {
    kind: "active";
    turnId: string;
    actions: readonly TurnTraceActionView[];
  }
  | {
    kind: "settled";
    turnId: string;
    expanded: boolean;
    durationMs: number;
    actionCount: number;
    summary: string;
    actions: readonly TurnTraceActionView[];
    interruptionMessage?: "Turn interrupted.";
  }
  | { kind: "hidden"; turnId: string }
  | { kind: "interrupted"; turnId: string; message: "Turn interrupted." };

const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  read: "Reading files",
  grep: "Searching code",
  find: "Finding files",
  ls: "Listing files",
  edit: "Editing files",
  write: "Writing files",
  bash: "Running commands",
  get_current_session_state: "Reading session state",
  mark_thread_done: "Updating threads",
  query_database: "Querying the session database",
  schedule_prompt: "Scheduling work",
  manage_schedule: "Managing schedules",
  delegate_agent: "Delegating to an agent",
  manage_agent_run: "Managing a delegated run",
});

/** Return the stable presentation label for an allowlisted tool, else omit the activity. */
export function semanticActionForTool(toolName: string): string | undefined {
  return TOOL_ACTION_LABELS[toolName];
}

export function createTurnTrace(turnId: string): TurnTrace {
  return { turnId, actions: [], eventIds: new Set() };
}

const oneLine = (value: string): string => value
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/** Purely apply one normalized source event. Unknown tools and duplicate event IDs are no-ops. */
export function applyTurnTraceEvent(trace: TurnTrace, event: TurnActivityEvent): TurnTrace {
  if (event.turnId !== trace.turnId) return trace;
  if (trace.settledAt !== undefined) return trace;
  if (event.kind === "turn_started") {
    return trace.startedAt === undefined ? { ...trace, startedAt: event.at } : trace;
  }
  if (event.kind === "turn_settled") {
    return {
      ...trace,
      settledAt: event.at,
      outcome: event.outcome,
      ...(event.hasResponse ? { hasResponse: true as const } : {}),
    };
  }
  if (trace.eventIds.has(event.eventId)) return trace;

  const label = event.kind === "thinking_summary"
    ? oneLine(event.summary)
    : semanticActionForTool(event.toolName);
  if (!label) return trace;

  const eventIds = new Set(trace.eventIds);
  eventIds.add(event.eventId);
  return {
    ...trace,
    actions: [...trace.actions, { eventId: event.eventId, kind: event.kind, label }],
    eventIds,
  };
}

/** Stable compact duration shared by core views and surface adapters. */
export function formatTurnDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${seconds}s`;
}

const actionViews = (trace: TurnTrace, active: boolean): TurnTraceActionView[] =>
  trace.actions.map((action, index) => {
    const current = active && index === trace.actions.length - 1;
    return {
      kind: action.kind,
      label: action.label,
      marker: current ? "●" : "│",
      emphasis: current ? "current" : "muted",
    };
  });

/** Derive the complete presentation view. Expansion is caller-owned per-turn state. */
export function deriveTurnTraceView(
  trace: TurnTrace,
  options: { expanded?: boolean; interruptedAt?: number } = {},
): TurnTraceView {
  const derivedInterruption = trace.settledAt === undefined && options.interruptedAt !== undefined;
  const settledAt = trace.settledAt ?? options.interruptedAt;
  const outcome = derivedInterruption ? "interrupted" : trace.outcome;
  if (settledAt === undefined) {
    return { kind: "active", turnId: trace.turnId, actions: actionViews(trace, true) };
  }
  if (trace.actions.length === 0) {
    if (trace.hasResponse) return { kind: "hidden", turnId: trace.turnId };
    if (outcome === "interrupted") return { kind: "interrupted", turnId: trace.turnId, message: "Turn interrupted." };
    return { kind: "hidden", turnId: trace.turnId };
  }

  const durationMs = Math.max(0, settledAt - (trace.startedAt ?? settledAt));
  const actionCount = trace.actions.length;
  const expanded = options.expanded === true;
  return {
    kind: "settled",
    turnId: trace.turnId,
    expanded,
    durationMs,
    actionCount,
    summary: `Worked for ${formatTurnDuration(durationMs)} · ${actionCount} action${actionCount === 1 ? "" : "s"}`,
    actions: expanded ? actionViews(trace, false) : [],
    ...(outcome === "interrupted" && !trace.hasResponse
      ? { interruptionMessage: "Turn interrupted." as const }
      : {}),
  };
}

/** Replay retained events through the same reducer used by live ingestion. */
export function replayTurnTrace(
  events: readonly TurnActivityEvent[],
  options: { expanded?: boolean; transcriptEnded?: boolean } = {},
): TurnTraceView {
  const first = events[0];
  if (!first) throw new Error("Cannot replay an empty turn trace");
  let trace = createTurnTrace(first.turnId);
  for (const event of events) trace = applyTurnTraceEvent(trace, event);
  return deriveTurnTraceView(trace, {
    expanded: options.expanded,
    ...(options.transcriptEnded && trace.settledAt === undefined ? { interruptedAt: events.at(-1)?.at } : {}),
  });
}

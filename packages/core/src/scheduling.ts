/** Closed scheduler vocabulary shared by clients, state, and the daemon runtime. */
export enum ScheduleKind {
  At = "at",
  Every = "every",
  Cron = "cron",
  NeedsYou = "needs-you",
}

export enum ScheduledPayloadKind {
  Prompt = "prompt",
  Command = "command",
}

export enum ScheduleRunStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Interrupted = "interrupted",
}

export enum ScheduleRunTrigger {
  Scheduled = "scheduled",
  Manual = "manual",
  NeedsYou = "needs-you",
}

export enum AgentToolId {
  Bash = "bash",
  Edit = "edit",
  Find = "find",
  Grep = "grep",
  Ls = "ls",
  Read = "read",
  Write = "write",
  GetCurrentSessionState = "get_current_session_state",
  MarkThreadDone = "mark_thread_done",
  QueryDatabase = "query_database",
  SchedulePrompt = "schedule_prompt",
  ManageSchedule = "manage_schedule",
}

export type ScheduleTrigger =
  | { kind: ScheduleKind.At; at: string }
  | { kind: ScheduleKind.Every; everyMs: number; anchorMs: number }
  | { kind: ScheduleKind.Cron; expression: string; timeZone: string }
  | { kind: ScheduleKind.NeedsYou };

export interface ScheduledPromptPayload {
  kind: ScheduledPayloadKind.Prompt;
  prompt: string;
  toolsAllow?: readonly AgentToolId[];
}

export interface ScheduledCommandPayload {
  kind: ScheduledPayloadKind.Command;
  argv: readonly [string, ...string[]];
}

export type ScheduledPayload = ScheduledPromptPayload | ScheduledCommandPayload;

export interface ScheduleDefinition {
  id: string;
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  payload: ScheduledPayload;
  /** Absolute working directory captured when the job is created. */
  cwd: string;
  timeoutSeconds: number;
  /** Monotonic optimistic-concurrency token for future-trigger mutations. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
}

export type ScheduleCreateInput = Pick<
  ScheduleDefinition,
  "name" | "enabled" | "trigger" | "payload" | "cwd" | "timeoutSeconds"
>;

export interface ScheduleExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  transcriptId?: string;
}

/** Runtime request passed from the scheduler to the isolated Pi prompt harness. */
export interface ScheduledPromptRunRequest {
  payload: ScheduledPromptPayload;
  cwd: string;
  schedule: ScheduleDefinition;
  runId: string;
  signal: AbortSignal;
  triggerContext?: ScheduleTriggerContext;
}

export interface NeedsYouTriggerContext {
  threadIds: readonly string[];
  observedThrough: string;
}

export interface ScheduledTimeTriggerContext {
  scheduledFor: string | null;
  startedAfterMs: number;
  missedOccurrences: number;
}

export type ScheduleTriggerContext = NeedsYouTriggerContext | ScheduledTimeTriggerContext;

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  error: string | null;
  transcriptId: string | null;
  attemptCount: 1;
}

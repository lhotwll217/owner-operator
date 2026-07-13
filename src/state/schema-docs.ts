/** Git-tracked prompt surface served by list_tables/describe_table. Keep with database.ts. */
export interface ColumnDoc { name: string; description: string }
export interface TableDoc { name: string; description: string; columns: ColumnDoc[] }

export const SCHEMA_DOCS: TableDoc[] = [
  {
    name: "threads",
    description: "One mutable identity/observation row per external coding-agent thread. Current belief lives in thread_details.",
    columns: [
      { name: "id", description: "Stable coding-agent thread id." },
      { name: "repo", description: "Repository name." },
      { name: "project", description: "Absolute session working directory." },
      { name: "app", description: "Originating app or CLI." },
      { name: "source", description: "Transcript adapter id." },
      { name: "transcript_path", description: "Absolute transcript path, when known." },
      { name: "created_at", description: "ISO session creation time." },
      { name: "first_seen_at", description: "ISO first observation time." },
      { name: "last_seen_at", description: "ISO latest scan observation." },
      { name: "last_active_at", description: "ISO latest activity." },
      { name: "last_message_at", description: "ISO latest conversation message; enrichment watermark source." },
      { name: "last_checked_at", description: "ISO latest monitor check." },
      { name: "diff_added", description: "Workspace lines added." },
      { name: "diff_deleted", description: "Workspace lines deleted." },
      { name: "raw_topic", description: "Transcript-derived display fallback." },
      { name: "owner_title", description: "Owner-pinned title; NULL means generated title wins." },
      { name: "enriched_through_message_at", description: "Latest message timestamp incorporated into model enrichment." },
    ],
  },
  {
    name: "thread_details",
    description: "Append-only dense belief ledger. MAX(version) is current; ORDER BY version is one thread's audit trail.",
    columns: [
      { name: "thread_id", description: "References threads.id." },
      { name: "version", description: "Per-thread monotonic version; part of the primary key." },
      { name: "created_at", description: "ISO time this belief became current (also stateSince)." },
      { name: "written_by", description: "poll | model | owner." },
      { name: "state", description: "needs-you | working | idle | done." },
      { name: "state_reason", description: "Optional explanation for the current state." },
      { name: "priority", description: "Model-assigned owner attention, 1-5." },
      { name: "topic", description: "Generated title; the widget/CLI row title unless owner_title overrides." },
      { name: "summary", description: "Legacy model recap; enrichment no longer writes it and clears it as threads re-enrich." },
      { name: "next_steps", description: "Concrete action needed from the owner; the widget's arrow line." },
    ],
  },
  {
    name: "schedules",
    description: "Durable user-authored jobs. For job configuration/status, inspect enabled, trigger_json, payload_json, and next_run_at.",
    columns: [
      { name: "id", description: "Stable schedule id." },
      { name: "name", description: "Unique human-readable name." },
      { name: "enabled", description: "1 permits future triggers." },
      { name: "trigger_kind", description: "at | every | cron | needs-you." },
      { name: "trigger_json", description: "Typed trigger snapshot." },
      { name: "payload_kind", description: "prompt | command." },
      { name: "payload_json", description: "Typed prompt or argv payload; contains no job-specific environment values." },
      { name: "cwd", description: "Absolute run working directory." },
      { name: "timeout_seconds", description: "Per-run timeout." },
      { name: "revision", description: "Monotonic optimistic-concurrency token." },
      { name: "created_at", description: "ISO creation time." },
      { name: "updated_at", description: "ISO last edit time." },
      { name: "next_run_at", description: "ISO next timer occurrence; NULL for event triggers/disabled jobs." },
      { name: "deleted_at", description: "Soft-delete ISO; deleted jobs no longer trigger." },
    ],
  },
  {
    name: "schedule_runs",
    description: "Durable execution history. For failed/interrupted schedule intent, filter status and inspect error, stderr_tail, stdout_tail, and transcript_id.",
    columns: [
      { name: "id", description: "Stable run id." },
      { name: "schedule_id", description: "References schedules.id; history survives soft deletion." },
      { name: "trigger", description: "scheduled | manual | needs-you." },
      { name: "trigger_context_json", description: "Missed-run timing or typed needs-you thread batch." },
      { name: "payload_snapshot_json", description: "Immutable payload actually executed." },
      { name: "cwd", description: "Immutable cwd actually used." },
      { name: "timeout_seconds", description: "Immutable timeout actually used." },
      { name: "status", description: "running | completed | failed | interrupted." },
      { name: "created_at", description: "ISO claim time." },
      { name: "scheduled_for", description: "ISO intended timer occurrence, when applicable." },
      { name: "started_at", description: "ISO execution start." },
      { name: "finished_at", description: "ISO terminal time." },
      { name: "exit_code", description: "Command/prompt result code when available." },
      { name: "stdout_tail", description: "Bounded final stdout bytes." },
      { name: "stderr_tail", description: "Bounded final stderr bytes." },
      { name: "error", description: "Terminal failure/interruption explanation." },
      { name: "transcript_id", description: "Fresh Owner Operator transcript id for a prompt run." },
      { name: "attempt_count", description: "Always 1 in V0; scheduler has no retry loop." },
    ],
  },
  {
    name: "schedule_event_watermarks",
    description: "Internal durable dedupe for needs-you event jobs; not a delivery queue.",
    columns: [
      { name: "schedule_id", description: "Event schedule id." },
      { name: "thread_id", description: "External coding-agent thread id." },
      { name: "last_message_at", description: "Latest message claimed by this schedule." },
    ],
  },
];

export function tableDoc(name: string): TableDoc | undefined {
  return SCHEMA_DOCS.find((table) => table.name === name);
}

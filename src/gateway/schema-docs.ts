// Owner Operator — the agent-facing documentation of the session database.
//
// THIS IS A PROMPT SURFACE. The query_database tool serves these descriptions verbatim
// to the Operator on list_tables/describe_table, so they steer how the model queries —
// treat edits like prompt edits (see eval/). Descriptions live HERE, in code, on
// purpose: sqlite_master's stored CREATE text is frozen at whatever ran first on a
// given machine's db file, while this module is git-tracked, reviewed, and versioned
// with the code that writes the tables. Column EXISTENCE always comes live from the db
// (PRAGMA table_info); only the descriptions are virtual.
//
// Keep in lockstep with SCHEMA in threads-db.ts.

export interface ColumnDoc {
  name: string;
  description: string;
}

export interface TableDoc {
  name: string;
  description: string;
  columns: ColumnDoc[];
}

export const SCHEMA_DOCS: TableDoc[] = [
  {
    name: "threads",
    description:
      "One row per agent thread: identity plus live observation. Mutable in place — " +
      "activity timestamps tick on every poll. What we believe about a thread " +
      "(state, topic, summary) lives in thread_details.",
    columns: [
      { name: "id", description: "Thread/session id — joins thread_details.thread_id." },
      { name: "repo", description: "Repository name the session runs in." },
      { name: "project", description: "Session cwd (absolute path)." },
      { name: "app", description: "App/GUI the session was made from (e.g. Claude CLI)." },
      { name: "source", description: "Transcript source adapter (claude, codex, pi, …)." },
      { name: "transcript_path", description: "Absolute path of the session transcript." },
      { name: "created_at", description: "ISO — when the session itself started." },
      { name: "first_seen_at", description: "ISO — first poll that saw this thread (insert-only)." },
      { name: "last_seen_at", description: "ISO — most recent poll that saw this thread." },
      { name: "last_active_at", description: "ISO — last observed activity." },
      { name: "last_message_at", description: "ISO — last conversation message (the recency signal displays use)." },
      { name: "last_assistant_at", description: "ISO — last assistant message." },
      { name: "last_user_at", description: "ISO — last user message." },
      { name: "last_checked_at", description: "ISO — last poll pass that checked this thread." },
      { name: "in_snapshot", description: "1 = in the current poll window; 0 = historical row (kept forever)." },
      { name: "diff_added", description: "Workspace lines added vs the repo's base branch." },
      { name: "diff_deleted", description: "Workspace lines deleted vs the repo's base branch." },
      { name: "raw_topic", description: "Topic scraped from the transcript — display fallback." },
      { name: "owner_title", description: "Owner-set rename; wins over generated topics at display. NULL = none." },
    ],
  },
  {
    name: "thread_details",
    description:
      "Append-only versioned ledger of belief about each thread — NEVER updated in " +
      "place. The MAX(version) row per thread is the current truth; the full history " +
      "is the audit trail (one thread's story = SELECT * WHERE thread_id = ? ORDER BY " +
      "version). Rows are dense: every version carries all fields. Versions land only " +
      "on semantic change, so state edges and enrichment rewrites are the only rows — " +
      "time-in-state metrics come from diffing consecutive versions' state/created_at.",
    columns: [
      { name: "thread_id", description: "References threads.id." },
      { name: "version", description: "Per-thread, monotonic from 1. (thread_id, version) is the primary key." },
      { name: "created_at", description: "ISO — when this belief was recorded." },
      { name: "written_by", description: "Writer: poll (observed state), model (enrichment), owner (e.g. /done), migration (seed)." },
      { name: "state", description: "needs-you | working | idle | done. done is owner-set and holds until a newer message." },
      { name: "state_reason", description: "Why the state is what it is (cleared on state change unless re-claimed)." },
      { name: "priority", description: "Model-assigned loudness, higher = louder. state = what's happening; priority = how loud." },
      { name: "topic", description: "Model-generated title (owner_title wins at display)." },
      { name: "summary", description: "Model-written recap of the thread as of this version." },
      { name: "next_steps", description: "Model-suggested next action for the owner." },
    ],
  },
  {
    name: "meta",
    description: "Store-level key/value pairs. polled_at = the current snapshot's ISO timestamp.",
    columns: [
      { name: "key", description: "Key name." },
      { name: "value", description: "Value (text)." },
    ],
  },
  {
    name: "schedules",
    description: "Daemon-run schedules: when to run what, plus last-run bookkeeping. Shapes in the *_json columns follow protocol.ts.",
    columns: [
      { name: "name", description: "Unique schedule name." },
      { name: "when_json", description: "JSON — when to fire." },
      { name: "action_json", description: "JSON — what to do." },
      { name: "enabled", description: "1 = active." },
      { name: "created_at", description: "ISO — when the schedule was created." },
      { name: "last_run_at", description: "ISO — last firing, if any." },
      { name: "last_result_json", description: "JSON — last firing's result, if any." },
    ],
  },
  {
    name: "thread_triage",
    description:
      "LEGACY, read-only: pre-ledger model-output history (no state recorded alongside), " +
      "kept for archaeology. Superseded by thread_details; present only on dbs that " +
      "predate the cutover. Nothing writes it.",
    columns: [],
  },
];

/** Doc for one table, or undefined for tables this module doesn't know. */
export function tableDoc(name: string): TableDoc | undefined {
  return SCHEMA_DOCS.find((t) => t.name === name);
}

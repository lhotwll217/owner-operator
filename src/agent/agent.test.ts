// Unit: Owner Operator session tool allowlists.
import assert from "node:assert";
import {
  ownerOperatorTools,
  ownerOperatorCustomTools,
} from "./agent";

// No shell or raw write/mutation tools on the owner channel — and transcript access only
// through the session tools: general search/list tools are out (search_sessions and
// query_database cover them), so no-raw-transcript-reads is structural, not instructed.
for (const forbidden of ["bash", "edit", "write", "grep", "find", "ls"]) {
  assert.ok(!ownerOperatorTools.includes(forbidden), `owner tools must NOT include ${forbidden}`);
}

// The tools it needs are present.
for (const t of ["read", "get_current_session_state", "mark_thread_done", "query_database", "search_sessions", "schedule_prompt"]) {
  assert.ok(ownerOperatorTools.includes(t), `owner tools must include ${t}`);
}

// Every allowlisted custom tool ships (so the allowlist can't reference a missing tool).
// The raw file tools are same-name extension overrides, covered by privacy-tools.test.
for (const t of ["get_current_session_state", "mark_thread_done", "query_database", "search_sessions"]) {
  assert.ok(ownerOperatorCustomTools.some((tool) => tool.name === t), `owner custom tools must include ${t}`);
}

process.stdout.write("ok — session tool allowlists: no shell/write tools; raw file tools are extension-owned overrides\n");

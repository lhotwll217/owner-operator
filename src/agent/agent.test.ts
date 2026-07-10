// Unit: Owner Operator session tool allowlists.
import assert from "node:assert";
import {
  ownerOperatorTools,
  ownerOperatorCustomTools,
} from "./agent";

// Mutation and broad file traversal stay out. The same-name bash override only executes
// the session-search skill helper; privacy-tools.integration.test proves arbitrary commands are rejected.
for (const forbidden of ["edit", "write", "grep", "find", "ls"]) {
  assert.ok(!ownerOperatorTools.some((tool) => tool === forbidden), `owner tools must NOT include ${forbidden}`);
}

// The tools it needs are present.
for (const t of ["bash", "read", "get_current_session_state", "mark_thread_done", "query_database", "schedule_prompt"]) {
  assert.ok(ownerOperatorTools.some((tool) => tool === t), `owner tools must include ${t}`);
}

// Every allowlisted custom tool ships (so the allowlist can't reference a missing tool).
// The raw file tools are same-name extension overrides, covered by privacy-tools.test.
for (const t of ["get_current_session_state", "mark_thread_done", "query_database", "schedule_prompt"]) {
  assert.ok(ownerOperatorCustomTools.some((tool) => tool.name === t), `owner custom tools must include ${t}`);
}

assert.ok(!ownerOperatorCustomTools.some((tool) => tool.name === "search_sessions"), "session search is a skill, not a duplicate custom tool");

const queryTool = ownerOperatorCustomTools.find((tool) => tool.name === "query_database");
assert.doesNotMatch(
  queryTool?.description ?? "",
  /CREATE statement/,
  "query_database describes the documented columns it returns, not raw SQLite DDL",
);

process.stdout.write("ok — session capabilities: constrained skill execution plus typed state tools\n");

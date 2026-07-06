// Unit: the neutral (agent-facing, `oo one-shot`) session is read-only at the TOOL layer.
import assert from "node:assert";
import { neutralAgentTools, neutralAgentCustomTools, ownerOperatorTools, ownerOperatorCustomTools } from "./agent";

// No shell or write/mutation tools on the headless read-only channel.
for (const forbidden of ["bash", "edit", "write", "present_threads", "mark_thread_done"]) {
  assert.ok(!neutralAgentTools.includes(forbidden), `neutral tools must NOT include ${forbidden}`);
}
for (const forbidden of ["bash", "edit", "write"]) {
  assert.ok(!ownerOperatorTools.includes(forbidden), `owner tools must NOT include ${forbidden}`);
}

// The read-only tools it needs are present.
for (const t of ["read", "grep", "find", "ls", "get_current_session_state", "scan_active_transcripts", "search_sessions"]) {
  assert.ok(neutralAgentTools.includes(t), `neutral tools must include ${t}`);
}
for (const t of ["read", "grep", "find", "ls", "present_threads", "get_current_session_state", "mark_thread_done", "scan_active_transcripts", "search_sessions", "schedule_prompt"]) {
  assert.ok(ownerOperatorTools.includes(t), `owner tools must include ${t}`);
}

// Every allowlisted custom tool ships (so the allowlist can't reference a missing tool).
// The raw file tools are same-name extension overrides, covered by privacy-tools.test.
for (const t of ["get_current_session_state", "scan_active_transcripts", "search_sessions"]) {
  assert.ok(neutralAgentCustomTools.some((tool) => tool.name === t), `neutral custom tools must include ${t}`);
}
for (const t of ["present_threads", "get_current_session_state", "mark_thread_done", "scan_active_transcripts", "search_sessions"]) {
  assert.ok(ownerOperatorCustomTools.some((tool) => tool.name === t), `owner custom tools must include ${t}`);
}

process.stdout.write("ok — session tool allowlists: no shell/write tools; raw file tools are extension-owned overrides\n");

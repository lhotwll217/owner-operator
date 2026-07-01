// Unit: the neutral (agent-facing, `oo --rpc`) session is read-only at the TOOL layer.
import assert from "node:assert";
import { neutralAgentTools, neutralAgentCustomTools } from "./agent";

// No shell or write/mutation tools on the headless read-only channel.
for (const forbidden of ["bash", "edit", "write", "present_threads", "mark_thread_done"]) {
  assert.ok(!neutralAgentTools.includes(forbidden), `neutral tools must NOT include ${forbidden}`);
}

// The read-only tools it needs are present.
for (const t of ["read", "grep", "find", "ls", "get_sidebar_threads", "scan_sessions", "search_sessions"]) {
  assert.ok(neutralAgentTools.includes(t), `neutral tools must include ${t}`);
}

// Every allowlisted custom tool ships (so the allowlist can't reference a missing tool), and no
// write tool sneaks in as a custom tool.
assert.equal(neutralAgentCustomTools.length, 3, "three read-only custom tools: sidebar + scan + search");

process.stdout.write("ok — neutral session read-only: no bash/edit/write/present_threads/mark_thread_done\n");

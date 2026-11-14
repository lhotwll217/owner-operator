import assert from "node:assert/strict";
import { claudeHookFact } from "./claude-hook";
import { reduceHookFacts, type HookFact } from "./hook-lifecycle";

const fact = (kind: HookFact["kind"], extra: Partial<HookFact> = {}): HookFact => ({
  kind,
  toolName: null,
  toolUseId: null,
  agentId: null,
  ...extra,
});

const life = (...facts: HookFact[]) => reduceHookFacts(facts);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("permission-requested", { toolName: "Bash" }),
    fact("tool-started", { toolName: "Read", toolUseId: "toolu_read" }),
  ),
  { state: "needs-you", wait: "permission" },
  "a real permission stays while a later unrelated tool starts",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("permission-requested", { toolName: "Bash", toolUseId: "toolu_bash" }),
    fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_bash" }),
  ),
  { state: "working", wait: null },
  "the permission's own tool finishing clears it",
);

assert.deepEqual(
  life(fact("turn-started"), fact("permission-requested", { toolName: "Bash" }), fact("turn-started")),
  { state: "working", wait: null },
  "a new owner prompt clears a permission",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("permission-requested", { toolName: "Bash", agentId: "agent_1" }),
    fact("tool-started", { toolName: "Read" }),
    fact("child-stopped", { agentId: "agent_1" }),
  ),
  { state: "working", wait: null },
  "the owning child ending clears its permission",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("question-requested", { toolName: "AskUserQuestion", toolUseId: "toolu_ask" }),
    fact("tool-started", { toolName: "Read", toolUseId: "toolu_read" }),
  ),
  { state: "working", wait: null },
  "a question clears when the next unrelated tool starts",
);

assert.deepEqual(
  life(fact("turn-started"), fact("child-started", { agentId: "agent_1" }), fact("turn-stopped")),
  { state: "working", wait: null },
  "a live child holds the session working after the lead stops",
);

assert.deepEqual(life(fact("turn-started"), fact("turn-stopped")), { state: "idle", wait: null });
assert.deepEqual(life(fact("turn-started"), fact("turn-failed")), { state: "needs-you", wait: null });

const parallelBash = [
  fact("turn-started"),
  fact("tool-started", { toolName: "Bash", toolUseId: "toolu_first" }),
  fact("tool-started", { toolName: "Bash", toolUseId: "toolu_second" }),
  fact("permission-requested", { toolName: "Bash" }),
];

assert.deepEqual(
  life(...parallelBash, fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_second" })),
  { state: "needs-you", wait: "permission" },
  "a permission survives one of two parallel same-name calls finishing",
);

assert.deepEqual(
  life(
    ...parallelBash,
    fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_second" }),
    fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_first" }),
  ),
  { state: "working", wait: null },
  "the permission clears once every call it could have been about has finished",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("tool-started", { toolName: "Write", toolUseId: "toolu_write" }),
    fact("permission-requested", { toolName: "Write" }),
    fact("batch-finished"),
  ),
  { state: "working", wait: null },
  "a batch end resolves a permission Claude denied itself, which fires no tool result",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("tool-started", { toolName: "Write", toolUseId: "toolu_write" }),
    fact("permission-requested", { toolName: "Write" }),
    fact("batch-finished", { agentId: "agent_1" }),
  ),
  { state: "needs-you", wait: "permission" },
  "a sub-agent's batch end leaves the lead's permission up",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("permission-requested", { toolName: "Write" }),
    fact("batch-finished"),
  ),
  { state: "needs-you", wait: "permission" },
  "a batch end never guesses at a permission whose call was never seen",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("tool-started", { toolName: "Write", toolUseId: "toolu_write" }),
    fact("permission-requested", { toolName: "Write" }),
    fact("turn-stopped"),
  ),
  { state: "idle", wait: null },
  "a permission nobody answered falls away when the turn ends, because rejecting the dialog fires no hook",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("tool-started", { toolName: "Write", toolUseId: "toolu_write" }),
    fact("permission-requested", { toolName: "Write" }),
    fact("tool-started", { toolName: "Read", toolUseId: "toolu_read" }),
    fact("tool-finished", { toolName: "Read", toolUseId: "toolu_read" }),
  ),
  { state: "needs-you", wait: "permission" },
  "a permission stays up through another call starting and finishing",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("question-requested", { toolName: "AskUserQuestion", toolUseId: "toolu_ask" }),
    fact("tool-started", { toolName: "Bash", toolUseId: "toolu_child_bash", agentId: "agent_1" }),
  ),
  { state: "needs-you", wait: "question" },
  "a sub-agent's tool does not answer the owner's question",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("child-started", { agentId: "agent_1" }),
    fact("turn-stopped"),
    fact("tool-started", { toolName: "Bash", toolUseId: "toolu_child", agentId: "agent_1" }),
    fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_child", agentId: "agent_1" }),
  ),
  { state: "working", wait: null },
  "a registered live child keeps the session working while it runs tools",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("child-started", { agentId: "agent_1" }),
    fact("turn-stopped"),
    fact("tool-started", { toolName: "Bash", toolUseId: "toolu_child", agentId: "agent_1" }),
    fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_child", agentId: "agent_1" }),
    fact("batch-finished", { agentId: "agent_1" }),
    fact("child-stopped", { agentId: "agent_1" }),
  ),
  { state: "idle", wait: null },
  "the child's tool activity stops holding the session working once that child stops",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("turn-stopped"),
    fact("tool-started", { toolName: "Bash", toolUseId: "toolu_orphan", agentId: "agent_9" }),
    fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_orphan", agentId: "agent_9" }),
    fact("batch-finished", { agentId: "agent_9" }),
  ),
  { state: "idle", wait: null },
  "a sub-agent's tool events never reopen the lead's finished turn",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("turn-failed"),
    fact("tool-started", { toolName: "Bash", toolUseId: "toolu_orphan", agentId: "agent_9" }),
    fact("tool-finished", { toolName: "Bash", toolUseId: "toolu_orphan", agentId: "agent_9" }),
  ),
  { state: "needs-you", wait: null },
  "a sub-agent's tool events never erase the lead's failed turn",
);

// Source values per https://code.claude.com/docs/en/hooks
for (const source of ["startup", "resume", "clear"]) {
  assert.equal(
    claudeHookFact({ hook_event_name: "SessionStart", source })?.kind,
    "session-started",
    `SessionStart source ${source} begins a session with no prior turn`,
  );
}
for (const source of ["compact", "fork", "a-source-claude-adds-later"]) {
  assert.equal(
    claudeHookFact({ hook_event_name: "SessionStart", source })?.kind,
    "session-continued",
    `SessionStart source ${source} can fire mid-session, so it must not wipe the lifecycle`,
  );
}

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("tool-started", { toolName: "Write", toolUseId: "toolu_write" }),
    fact("permission-requested", { toolName: "Write" }),
    fact("session-continued"),
  ),
  { state: "needs-you", wait: "permission" },
  "a compaction or fork session start leaves a live permission up",
);

assert.deepEqual(
  life(
    fact("turn-started"),
    fact("permission-requested", { toolName: "Write" }),
    fact("session-started"),
  ),
  { state: "idle", wait: null },
  "a session start with no prior turn wipes the lifecycle",
);

assert.deepEqual(
  claudeHookFact({ hook_event_name: "PermissionRequest", tool_name: "Bash", session_id: "s" }),
  { kind: "permission-requested", toolName: "Bash", toolUseId: null, agentId: null },
);
assert.deepEqual(
  claudeHookFact({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion" })?.kind,
  "question-requested",
);
assert.equal(claudeHookFact({ hook_event_name: "Notification" }), null);
assert.equal(claudeHookFact({}), null);

console.log("ok - hook lifecycle");

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

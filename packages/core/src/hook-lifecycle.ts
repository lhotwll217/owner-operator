// Harness-agnostic session lifecycle. Adapters (Claude today; Codex and OpenCode later)
// translate a payload into these facts. The reducer does not name a harness.
// A real permission stays up through later unrelated tool activity; a question clears
// on the next other tool. That is Orca PR #8311 (shouldKeepClaudePermissionVisible).

export type HookLifecycleState = "working" | "idle" | "needs-you";
export type HookWait = "permission" | "question";

export type HookFactKind =
  | "session-started"
  | "turn-started"
  | "tool-started"
  | "question-requested"
  | "permission-requested"
  | "tool-finished"
  | "batch-finished"
  | "turn-stopped"
  | "turn-failed"
  | "child-started"
  | "child-stopped";

export interface HookFact {
  kind: HookFactKind;
  toolName: string | null;
  toolUseId: string | null;
  agentId: string | null;
}

export interface HookLifecycle {
  state: HookLifecycleState;
  /** Set while the session is blocked on the owner. A question is not a permission. */
  wait: HookWait | null;
}

interface Memory {
  lead: "working" | "idle";
  failed: boolean;
  wait: HookWait | null;
  waitToolName: string | null;
  waitToolUseId: string | null;
  waitAgentId: string | null;
  children: string[];
}

function blank(): Memory {
  return {
    lead: "idle", failed: false, wait: null,
    waitToolName: null, waitToolUseId: null, waitAgentId: null, children: [],
  };
}

function clearWait(memory: Memory): Memory {
  return { ...memory, wait: null, waitToolName: null, waitToolUseId: null, waitAgentId: null };
}

function project(memory: Memory): HookLifecycle {
  const state: HookLifecycleState = memory.wait
    ? "needs-you"
    : memory.failed && memory.lead === "idle" && memory.children.length === 0
      ? "needs-you"
      : memory.lead === "working" || memory.children.length > 0
        ? "working"
        : "idle";
  return { state, wait: memory.wait };
}

function rememberWait(memory: Memory, wait: HookWait, fact: HookFact): Memory {
  return {
    ...memory,
    lead: "working",
    failed: false,
    wait,
    waitToolName: fact.toolName,
    waitToolUseId: fact.toolUseId ?? memory.waitToolUseId,
    waitAgentId: fact.agentId,
  };
}

function sameTool(memory: Memory, fact: HookFact): boolean {
  if (memory.waitToolUseId && fact.toolUseId) return memory.waitToolUseId === fact.toolUseId;
  return memory.waitToolName !== null && memory.waitToolName === fact.toolName;
}

function step(memory: Memory, fact: HookFact): Memory {
  switch (fact.kind) {
    case "turn-started":
      return { ...clearWait(memory), lead: "working", failed: false };
    case "session-started":
      return blank();
    case "child-started":
      if (!fact.agentId) return memory;
      return {
        ...memory,
        lead: memory.lead === "idle" && !memory.wait ? "working" : memory.lead,
        children: memory.children.includes(fact.agentId) ? memory.children : [...memory.children, fact.agentId],
      };
    case "child-stopped": {
      if (!fact.agentId) return memory;
      const cleared = memory.wait && memory.waitAgentId === fact.agentId ? clearWait(memory) : memory;
      return { ...cleared, children: memory.children.filter((id) => id !== fact.agentId) };
    }
    case "tool-started":
      if (memory.wait === "permission") return memory;
      return { ...clearWait(memory), lead: "working", failed: false };
    case "question-requested":
      return rememberWait(memory, "question", fact);
    case "permission-requested":
      return rememberWait(memory, "permission", fact);
    case "tool-finished":
      if (memory.wait === "permission") {
        return sameTool(memory, fact) ? { ...clearWait(memory), lead: "working" } : memory;
      }
      if (memory.wait === "question" && !sameTool(memory, fact)) {
        return { ...clearWait(memory), lead: "working", failed: false };
      }
      return { ...memory, lead: "working", failed: false };
    case "batch-finished":
      return { ...clearWait(memory), lead: "working", failed: false };
    case "turn-stopped":
      return { ...memory, lead: "idle" };
    case "turn-failed":
      return { ...memory, lead: "idle", failed: true };
    default:
      return memory;
  }
}

export function reduceHookFacts(facts: readonly HookFact[]): HookLifecycle {
  return project(facts.reduce(step, blank()));
}

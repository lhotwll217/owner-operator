// Harness-agnostic session lifecycle. Adapters (Claude today; Codex and OpenCode later)
// translate a payload into these facts. The reducer does not name a harness.
// A real permission stays up through later unrelated tool activity; a question clears
// on the next other tool. That is Orca PR #8311 (shouldKeepClaudePermissionVisible).

export type HookLifecycleState = "working" | "idle" | "needs-you";
export type HookWait = "permission" | "question";

export type HookFactKind =
  | "session-started"
  | "session-continued"
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

/** An announced, unresolved call. A null `agentId` is the lead; otherwise a sub-agent's own id. */
interface OpenCall {
  id: string;
  toolName: string | null;
  agentId: string | null;
}

interface Memory {
  lead: "working" | "idle";
  failed: boolean;
  wait: HookWait | null;
  waitToolName: string | null;
  waitAgentId: string | null;
  /** The open calls the wait could be about. Empty means none was identified, which only a
   * turn boundary releases. */
  waitCalls: string[];
  open: OpenCall[];
  children: string[];
}

function blank(): Memory {
  return {
    lead: "idle", failed: false, wait: null, waitToolName: null, waitAgentId: null,
    waitCalls: [], open: [], children: [],
  };
}

function clearWait(memory: Memory): Memory {
  return { ...memory, wait: null, waitToolName: null, waitAgentId: null, waitCalls: [] };
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

function opened(open: OpenCall[], fact: HookFact): OpenCall[] {
  if (!fact.toolUseId || open.some((call) => call.id === fact.toolUseId)) return open;
  return [...open, { id: fact.toolUseId, toolName: fact.toolName, agentId: fact.agentId }];
}

/** A PermissionRequest carries no tool id, so it may be about any open call under the same owner
 * and tool name. Orca matched the same way, because parallel calls interleave their hooks.
 * https://github.com/stablyai/orca/blob/dcd69a06f323ea73d788acc395ac4e9b0dbf9ecb/src/shared/agent-hook-listener/claude-tool-request-identity.ts#L66-L129 */
function rememberWait(memory: Memory, wait: HookWait, fact: HookFact): Memory {
  const open = opened(memory.open, fact);
  return {
    ...memory,
    lead: "working",
    failed: false,
    wait,
    waitToolName: fact.toolName,
    waitAgentId: fact.agentId,
    waitCalls: fact.toolUseId
      ? [fact.toolUseId]
      : open.filter((call) => call.agentId === fact.agentId && call.toolName === fact.toolName)
        .map((call) => call.id),
    open,
  };
}

function endCalls(memory: Memory, ended: (call: OpenCall) => boolean): Memory {
  const open = memory.open.filter((call) => !ended(call));
  const waitCalls = memory.waitCalls.filter((id) => open.some((call) => call.id === id));
  const settled = memory.wait === "permission" && memory.waitCalls.length > 0 && waitCalls.length === 0;
  return settled ? { ...clearWait(memory), open } : { ...memory, open, waitCalls };
}

/** A sub-agent reuses the session id while carrying its own agent id, so only a fact without
 * one speaks for the lead. */
function leadWorking(memory: Memory, fact: HookFact): Memory {
  return fact.agentId ? memory : { ...memory, lead: "working", failed: false };
}

function sameOwner(memory: Memory, fact: HookFact): boolean {
  return memory.waitAgentId === fact.agentId;
}

function sameTool(memory: Memory, fact: HookFact): boolean {
  if (fact.toolUseId && memory.waitCalls.length > 0) return memory.waitCalls.includes(fact.toolUseId);
  return memory.waitToolName !== null && memory.waitToolName === fact.toolName;
}

/** Nothing the lead asked for is on screen once its turn ends, and rejecting a permission
 * dialog fires no hook, so this boundary is that wait's only release. A sub-agent fires
 * SubagentStop rather than Stop, so a child's wait outlives the lead's turn. */
function endTurn(memory: Memory): Memory {
  const ended = endCalls(memory, (call) => call.agentId === null);
  return ended.waitAgentId === null ? clearWait(ended) : ended;
}

function step(memory: Memory, fact: HookFact): Memory {
  switch (fact.kind) {
    case "turn-started":
      return { ...clearWait(memory), open: [], lead: "working", failed: false };
    case "session-started":
      return blank();
    case "session-continued":
      return memory;
    case "child-started":
      if (!fact.agentId) return memory;
      return {
        ...memory,
        lead: memory.lead === "idle" && !memory.wait ? "working" : memory.lead,
        children: memory.children.includes(fact.agentId) ? memory.children : [...memory.children, fact.agentId],
      };
    case "child-stopped": {
      if (!fact.agentId) return memory;
      const ended = endCalls(memory, (call) => call.agentId === fact.agentId);
      const released = ended.wait && ended.waitAgentId === fact.agentId ? clearWait(ended) : ended;
      return { ...released, children: released.children.filter((id) => id !== fact.agentId) };
    }
    case "tool-started": {
      const grown = { ...memory, open: opened(memory.open, fact) };
      const movedOn = grown.wait === "question" && sameOwner(grown, fact);
      return leadWorking(movedOn ? clearWait(grown) : grown, fact);
    }
    case "question-requested":
      return rememberWait(memory, "question", fact);
    case "permission-requested":
      return rememberWait(memory, "permission", fact);
    case "tool-finished": {
      const ended = endCalls(memory, (call) => call.id === fact.toolUseId);
      const movedOn = ended.wait === "question" && sameOwner(ended, fact) && !sameTool(ended, fact);
      if (movedOn) return leadWorking(clearWait(ended), fact);
      const stillAsking = ended.wait === "permission";
      return stillAsking ? ended : leadWorking(ended, fact);
    }
    case "batch-finished":
      return leadWorking(endCalls(memory, (call) => call.agentId === fact.agentId), fact);
    case "turn-stopped":
      return { ...endTurn(memory), lead: "idle" };
    case "turn-failed":
      return { ...endTurn(memory), lead: "idle", failed: true };
    default:
      return memory;
  }
}

export function reduceHookFacts(facts: readonly HookFact[]): HookLifecycle {
  return project(facts.reduce(step, blank()));
}

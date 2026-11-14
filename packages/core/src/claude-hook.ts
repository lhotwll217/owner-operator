// Claude Code settings-hook payloads → harness-agnostic facts.
// Codex (hooks.json) and OpenCode (plugin event stream) will add their own adapters
// beside this one. Neither changes reduceHookFacts.

import type { HookFact } from "./hook-lifecycle";

/** The five `SessionStart.source` values are startup, resume, clear, compact and fork
 * (https://code.claude.com/docs/en/hooks). A source outside this set continues the session,
 * because a reset would wipe a live permission the owner still has to answer. */
const RESET_SESSION_SOURCES = new Set(["startup", "resume", "clear"]);

function field(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function isAsk(toolName: string | null): boolean {
  return toolName === "AskUserQuestion" || (toolName?.endsWith("__AskUserQuestion") ?? false);
}

/** The fields the lifecycle reads. Tool input is dropped here; it is not stored. */
export function claudeHookFact(body: Record<string, unknown>): HookFact | null {
  const eventName = field(body, "hook_event_name");
  if (!eventName) return null;
  const fact = {
    toolName: field(body, "tool_name"),
    toolUseId: field(body, "tool_use_id"),
    agentId: field(body, "agent_id"),
  };
  const ask = isAsk(fact.toolName);
  switch (eventName) {
    case "UserPromptSubmit":
      return { kind: "turn-started", ...fact };
    case "SessionStart": {
      const reset = RESET_SESSION_SOURCES.has(field(body, "source") ?? "");
      return { kind: reset ? "session-started" : "session-continued", ...fact };
    }
    case "SubagentStart":
      return fact.agentId ? { kind: "child-started", ...fact } : null;
    case "SubagentStop":
      return fact.agentId ? { kind: "child-stopped", ...fact } : null;
    case "PreToolUse":
      return { kind: ask ? "question-requested" : "tool-started", ...fact };
    case "PermissionRequest":
      return { kind: ask ? "question-requested" : "permission-requested", ...fact };
    case "PostToolUse":
    case "PostToolUseFailure":
      return { kind: "tool-finished", ...fact };
    case "PostToolBatch":
      return { kind: "batch-finished", ...fact };
    case "Stop":
      return { kind: "turn-stopped", ...fact };
    case "StopFailure":
      return fact.agentId ? { kind: "child-stopped", ...fact } : { kind: "turn-failed", ...fact };
    default:
      return null;
  }
}

import { applyEdits, modify, parse } from "jsonc-parser";

/** Events the managed Claude command listens for. Unknown events are left for a later adapter. */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

const MATCHED = new Set(["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"]);

/** Identifies our command inside a user-owned settings file. */
export const MANAGED_HOOK_MARKER = "hooks/claude-hook.sh";

interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookDefinition {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isManagedCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(MANAGED_HOOK_MARKER);
}

function withoutManaged(definitions: readonly HookDefinition[]): HookDefinition[] {
  return definitions.flatMap((definition) => {
    if (!Array.isArray(definition.hooks)) return [definition];
    const hooks = definition.hooks.filter((hook) => !isManagedCommand(hook.command));
    if (hooks.length === 0) return [];
    return [{ ...definition, hooks }];
  });
}

function managedDefinition(eventName: string, command: string): HookDefinition {
  const hook = { type: "command", command };
  return MATCHED.has(eventName) ? { matcher: "*", hooks: [hook] } : { hooks: [hook] };
}

/** Merge one managed command per event. Every other command in the file stays. */
export function mergeClaudeHookSettings(text: string, command: string): string {
  const parsed = parse(text.trim() ? text : "{}") as unknown;
  const root = isRecord(parsed) ? parsed : {};
  const current = isRecord(root.hooks) ? root.hooks : {};
  const hooks: Record<string, HookDefinition[]> = {};
  for (const [eventName, definitions] of Object.entries(current)) {
    hooks[eventName] = withoutManaged(Array.isArray(definitions) ? definitions as HookDefinition[] : []);
  }
  for (const eventName of CLAUDE_HOOK_EVENTS) {
    hooks[eventName] = [...(hooks[eventName] ?? []), managedDefinition(eventName, command)];
  }
  for (const [eventName, definitions] of Object.entries(hooks)) {
    if (definitions.length === 0) delete hooks[eventName];
  }
  const source = text.trim() ? text : "{}\n";
  return applyEdits(source, modify(source, ["hooks"], hooks, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  }));
}

/** Remove only managed commands. An event left with no commands is removed. */
export function removeClaudeHookSettings(text: string): string {
  const parsed = parse(text.trim() ? text : "{}") as unknown;
  const root = isRecord(parsed) ? parsed : {};
  if (!isRecord(root.hooks)) return text;
  const hooks: Record<string, HookDefinition[]> = {};
  for (const [eventName, definitions] of Object.entries(root.hooks)) {
    const kept = withoutManaged(Array.isArray(definitions) ? definitions as HookDefinition[] : []);
    if (kept.length) hooks[eventName] = kept;
  }
  const source = text.trim() ? text : "{}\n";
  return applyEdits(source, modify(source, ["hooks"], hooks, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  }));
}

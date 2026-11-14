import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/** Events the managed Claude command listens for. Unknown events are left for a later adapter. */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

export type ClaudeHookEvent = typeof CLAUDE_HOOK_EVENTS[number];

// Claude Code rejects a settings file naming a hook event it does not know, the owner's own hooks
// included, so each event waits for the release that introduced it. Floors measured by Orca from the
// CLI's packed enums: https://github.com/stablyai/orca/blob/dcd69a06f323ea73d788acc395ac4e9b0dbf9ecb/src/main/claude/cli-capabilities/claude-hook-event-versions.ts#L5-L24
const FIRST_VERSION: Record<ClaudeHookEvent, string> = {
  PreToolUse: "1.0.23",
  PostToolUse: "1.0.23",
  Stop: "1.0.31",
  SubagentStop: "1.0.41",
  UserPromptSubmit: "1.0.53",
  SessionStart: "1.0.62",
  SubagentStart: "2.0.43",
  PermissionRequest: "2.0.45",
  PostToolUseFailure: "2.0.56",
  StopFailure: "2.1.78",
  PostToolBatch: "2.1.118",
};

/**
 * The release from which naming an unknown hook event stopped costing the file: Claude Code skips
 * the entry it does not recognize and keeps the rest in effect.
 * https://github.com/anthropics/claude-code/blob/1c0586016060731d89d65c2b0616ff45b6842e2e/CHANGELOG.md#L7767
 * An unreadable version is assumed to be at least this, which is why it installs every event. The
 * other way round costs the whole feature: `PermissionRequest` and `PostToolBatch` are the events
 * Need You reads, both sit above this floor, and a probe that fails would install neither while
 * `oo hooks status` still said the hooks were installed.
 */
export const EVENT_NAMES_SURVIVE_FROM = "2.1.101";

const VERSION_ORDER = new Intl.Collator("en", { numeric: true });

/**
 * The events a given Claude Code accepts. Pass null when the version could not be read. Only the
 * `x.y.z` part counts, because numeric collation sorts a prerelease suffix above its own release.
 */
export function claudeHookEventsFor(claudeVersion: string | null): readonly ClaudeHookEvent[] {
  const version = /\d+\.\d+\.\d+/.exec(claudeVersion ?? "")?.[0];
  if (!version) return CLAUDE_HOOK_EVENTS;
  return CLAUDE_HOOK_EVENTS.filter((event) => VERSION_ORDER.compare(version, FIRST_VERSION[event]) >= 0);
}

// A batch end is a turn-level event, not a per-tool one, so it carries no matcher. Same split Orca
// makes: https://github.com/stablyai/orca/blob/dcd69a06f323ea73d788acc395ac4e9b0dbf9ecb/src/main/claude/hooks/claude-managed-hook-events.ts#L41-L56
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

/**
 * The file's root object, or null when we must not rewrite the file. `parse` error-recovers, and
 * `modify` edits the original text, so a broken file would keep its rules and gain a hooks block
 * while staying invalid JSON, which makes Claude Code reject the rules too.
 */
function settingsRoot(text: string): Record<string, unknown> | null {
  const errors: ParseError[] = [];
  const parsed = parse(text.trim() ? text : "{}", errors) as unknown;
  return errors.length === 0 && isRecord(parsed) ? parsed : null;
}

/** False when Claude Code would reject the file, so install must leave it alone. */
export function isParsableClaudeSettings(text: string): boolean {
  return settingsRoot(text) !== null;
}

function writeHooks(text: string, hooks: Record<string, HookDefinition[]>): string {
  const source = text.trim() ? text : "{}\n";
  return applyEdits(source, modify(source, ["hooks"], hooks, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  }));
}

/** Merge one managed command per event. Every other command in the file stays. Null refuses. */
export function mergeClaudeHookSettings(
  text: string,
  command: string,
  events: readonly ClaudeHookEvent[] = CLAUDE_HOOK_EVENTS,
): string | null {
  const root = settingsRoot(text);
  if (!root) return null;
  const current = isRecord(root.hooks) ? root.hooks : {};
  const hooks: Record<string, HookDefinition[]> = {};
  for (const [eventName, definitions] of Object.entries(current)) {
    hooks[eventName] = withoutManaged(Array.isArray(definitions) ? definitions as HookDefinition[] : []);
  }
  for (const eventName of events) {
    hooks[eventName] = [...(hooks[eventName] ?? []), managedDefinition(eventName, command)];
  }
  for (const [eventName, definitions] of Object.entries(hooks)) {
    if (definitions.length === 0) delete hooks[eventName];
  }
  return writeHooks(text, hooks);
}

/** Remove only managed commands. An event left with no commands is removed. Null refuses. */
export function removeClaudeHookSettings(text: string): string | null {
  const root = settingsRoot(text);
  if (!root) return null;
  if (!isRecord(root.hooks)) return text;
  const hooks: Record<string, HookDefinition[]> = {};
  for (const [eventName, definitions] of Object.entries(root.hooks)) {
    const kept = withoutManaged(Array.isArray(definitions) ? definitions as HookDefinition[] : []);
    if (kept.length) hooks[eventName] = kept;
  }
  return writeHooks(text, hooks);
}

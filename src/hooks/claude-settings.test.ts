import assert from "node:assert/strict";
import { parse } from "jsonc-parser";
import {
  CLAUDE_HOOK_EVENTS,
  claudeHookEventsFor,
  isParsableClaudeSettings,
  mergeClaudeHookSettings,
  removeClaudeHookSettings,
} from "./claude-settings";

interface ParsedSettings {
  hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]>;
}

const hooksOf = (text: string): NonNullable<ParsedSettings["hooks"]> => {
  const parsed = parse(text) as ParsedSettings;
  assert.ok(parsed.hooks, "the merged file must carry a hooks object");
  return parsed.hooks;
};

const original = `{
  // owner theme
  "theme": "dark",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo keep-me" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/tmp/hooks/claude-hook.sh" }] }
    ]
  }
}
`;

const command = "/Users/owner/.owner-operator/hooks/claude-hook.sh";
const merged = mergeClaudeHookSettings(original, command);
assert.ok(merged !== null, "a settings file with comments is mergeable");
assert.match(merged, /owner theme/);
assert.match(merged, /"theme": "dark"/);
assert.match(merged, /echo keep-me/);
assert.equal(merged.split(command).length - 1, CLAUDE_HOOK_EVENTS.length, "one managed command per event");
assert.equal(merged.split("claude-hook.sh").length - 1, CLAUDE_HOOK_EVENTS.length, "the previous managed Stop command is replaced");

const again = mergeClaudeHookSettings(merged, command);
assert.ok(again !== null);
assert.equal(again.split(command).length - 1, CLAUDE_HOOK_EVENTS.length, "a second install does not duplicate the command");
assert.match(again, /echo keep-me/);

const removed = removeClaudeHookSettings(again);
assert.ok(removed !== null);
assert.doesNotMatch(removed, /claude-hook\.sh/);
assert.match(removed, /echo keep-me/);
assert.match(removed, /owner theme/);

assert.ok(CLAUDE_HOOK_EVENTS.includes("PostToolBatch"),
  "PostToolBatch is the only release for a permission Claude denied itself");
assert.equal(hooksOf(merged).PostToolBatch?.[0]?.matcher, undefined,
  "a batch end is a lifecycle event, so it carries no tool matcher");
assert.equal(hooksOf(merged).PreToolUse?.at(-1)?.matcher, "*",
  "per-tool events keep the wildcard matcher");

// Installing an event the running Claude Code does not know voids the whole settings file,
// the owner's own hooks included.
assert.deepEqual([...claudeHookEventsFor("2.1.280")], [...CLAUDE_HOOK_EVENTS],
  "a current Claude Code takes every managed event");
assert.deepEqual([...claudeHookEventsFor("2.0.56")], [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop",
], "2.0.56 predates StopFailure (2.1.78) and PostToolBatch (2.1.118)");
const conservative = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"];
assert.deepEqual([...claudeHookEventsFor("1.0.64")], conservative);
assert.deepEqual([...claudeHookEventsFor(null)], conservative,
  "an unreadable version installs the core lifecycle rather than guessing forward");
assert.deepEqual([...claudeHookEventsFor("not a version at all")], conservative);
assert.deepEqual([...claudeHookEventsFor("2.1.9")], [...claudeHookEventsFor("2.0.56")],
  "2.1.9 is older than 2.1.78, not newer");
for (const event of claudeHookEventsFor("2.1.280")) {
  assert.ok(CLAUDE_HOOK_EVENTS.includes(event), `${event} must be a managed event`);
}

const gated = mergeClaudeHookSettings(original, command, claudeHookEventsFor("1.0.64"));
assert.ok(gated !== null);
assert.deepEqual(Object.keys(hooksOf(gated)).sort(), [...conservative].sort(),
  "a gated install writes only the events that version knows");

// A command installed before the quoting fix must still uninstall cleanly.
const legacy = `{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/Users/owner/My OO Home/hooks/claude-hook.sh" }] },
      { "hooks": [{ "type": "command", "command": "echo keep-me" }] }
    ]
  }
}
`;
const legacyRemoved = removeClaudeHookSettings(legacy);
assert.ok(legacyRemoved !== null);
assert.doesNotMatch(legacyRemoved, /claude-hook\.sh/);
assert.match(legacyRemoved, /echo keep-me/);

for (const [shape, text] of Object.entries({
  truncated: `{\n  "permissions": { "allow": ["Bash(ls:*)"] },\n`,
  trailingComma: `{\n  "theme": "dark",\n}\n`,
  mergeConflict: `<<<<<<< HEAD\n{ "theme": "dark" }\n=======\n{ "theme": "light" }\n>>>>>>> other\n`,
  garbage: "this is not json at all\n",
  yaml: "theme: dark\npermissions:\n  allow:\n    - Bash\n",
  stringRoot: `"{\\"theme\\":\\"dark\\"}"\n`,
  arrayRoot: "[1, 2, 3]\n",
})) {
  assert.equal(isParsableClaudeSettings(text), false, `${shape} is not a settings file we may rewrite`);
  assert.equal(mergeClaudeHookSettings(text, command), null, `${shape} must not be merged`);
  assert.equal(removeClaudeHookSettings(text), null, `${shape} must not be rewritten on uninstall`);
}
assert.equal(isParsableClaudeSettings(original), true, "comments are valid in a Claude settings file");
assert.equal(isParsableClaudeSettings(""), true, "an empty file is an empty object");

console.log("ok - claude hook settings keep user hooks");

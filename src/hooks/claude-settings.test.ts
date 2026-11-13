import assert from "node:assert/strict";
import { CLAUDE_HOOK_EVENTS, mergeClaudeHookSettings, removeClaudeHookSettings } from "./claude-settings";

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
assert.match(merged, /owner theme/);
assert.match(merged, /"theme": "dark"/);
assert.match(merged, /echo keep-me/);
assert.equal(merged.split(command).length - 1, CLAUDE_HOOK_EVENTS.length, "one managed command per event");
assert.equal(merged.split("claude-hook.sh").length - 1, CLAUDE_HOOK_EVENTS.length, "the previous managed Stop command is replaced");

const again = mergeClaudeHookSettings(merged, command);
assert.equal(again.split(command).length - 1, CLAUDE_HOOK_EVENTS.length, "a second install does not duplicate the command");
assert.match(again, /echo keep-me/);

const removed = removeClaudeHookSettings(again);
assert.doesNotMatch(removed, /claude-hook\.sh/);
assert.match(removed, /echo keep-me/);
assert.match(removed, /owner theme/);

console.log("ok - claude hook settings keep user hooks");

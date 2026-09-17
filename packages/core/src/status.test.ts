import assert from "node:assert";
import {
  cleanTopic,
  deriveState,
  formatRelative,
  IDLE_AFTER_SECONDS,
} from "./status";

assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: 60, working: false }), "idle");
assert.equal(deriveState({ lastRole: "user", secondsSinceLastMessage: 60, working: false }), "working");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: 60, working: true }), "working");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: IDLE_AFTER_SECONDS, working: false }), "idle");


assert.equal(cleanTopic("<command-name>/goal</command-name> ship it"), "/goal ship it");
assert.equal(cleanTopic("<x></x>"), "(untitled)");
assert.equal(formatRelative(60), "1 minute ago");
assert.equal(formatRelative(172800), "2 days ago");

process.stdout.write("ok — status vocabulary and ordering\n");

import assert from "node:assert";
import {
  cleanTopic,
  deriveState,
  formatRelative,
  IDLE_AFTER_SECONDS,
  sortByAttention,
  type ThreadStatus,
} from "./status";

assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: 60, working: false }), "needs-you");
assert.equal(deriveState({ lastRole: "user", secondsSinceLastMessage: 60, working: false }), "working");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: 60, working: true }), "working");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: IDLE_AFTER_SECONDS, working: false }), "idle");

const thread = (id: string, state: ThreadStatus["state"], lastMessageAt: string): ThreadStatus => ({
  id, state, lastMessageAt,
  source: "codex", repo: "demo", app: "Codex", topic: id,
  lastActive: "just now", createdAt: lastMessageAt, firstSeen: lastMessageAt,
});
assert.deepEqual(
  sortByAttention([
    thread("idle", "idle", "2026-07-09T10:03:00.000Z"),
    thread("working", "working", "2026-07-09T10:02:00.000Z"),
    thread("needs", "needs-you", "2026-07-09T10:01:00.000Z"),
  ]).map((item) => item.id),
  ["needs", "working", "idle"],
);

assert.equal(cleanTopic("<command-name>/goal</command-name> ship it"), "/goal ship it");
assert.equal(cleanTopic("<x></x>"), "(untitled)");
assert.equal(formatRelative(60), "1 minute ago");
assert.equal(formatRelative(172800), "2 days ago");

process.stdout.write("ok — status vocabulary and ordering\n");

import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { State } from "../state/state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";
import { ClaudeDesktopSessions } from "./claude-desktop-sessions";
import { SessionMonitor } from "./monitor";

const { dir, cleanup } = tempOoHome("oo-claude-desktop");
const root = join(dir, "claude-code-sessions");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const record = (cli: string | undefined, session: string, body?: string, at = new Date("2026-06-09T10:00:00Z")): string => {
  const path = join(root, "account", "org", `local_${session}.json`);
  mkdirSync(join(root, "account", "org"), { recursive: true });
  writeFileSync(path, body ?? JSON.stringify({ sessionId: `local_${session}`, ...(cli ? { cliSessionId: cli } : {}) }));
  utimesSync(path, at, at);
  return path;
};
const link = (session: string) => `claude://claude.ai/epitaxy/local_${session}`;

try {
  assert.deepEqual(await new ClaudeDesktopSessions(join(dir, "absent")).links(["thread-1"]), new Map(), "a missing root yields no links");

  record("thread-1", uuid(1));
  record("thread-2", uuid(2), "{not json");
  record(undefined, uuid(3));
  record("thread-4", "not-a-uuid");
  record("thread-5", uuid(5));
  record("thread-5", uuid(55));
  writeFileSync(join(root, "account", "stray.json"), JSON.stringify({ sessionId: `local_${uuid(6)}`, cliSessionId: "thread-6" }));
  const sessions = new ClaudeDesktopSessions(root);
  assert.deepEqual(
    await sessions.links(["thread-1", "thread-2", "thread-4", "thread-5", "thread-6", "unknown"]),
    new Map([["thread-1", link(uuid(1))]]),
    "only a well-formed, unambiguous record two levels down yields a link",
  );

  const path = join(root, "account", "org", `local_${uuid(1)}.json`);
  const original = new Date("2026-06-09T10:00:00Z");
  writeFileSync(path, JSON.stringify({ sessionId: `local_${uuid(7)}`, cliSessionId: "thread-1" }));
  utimesSync(path, original, original);
  assert.equal((await sessions.links(["thread-1"])).get("thread-1"), link(uuid(1)), "an unchanged mtime is not re-read");
  const later = new Date("2026-06-09T11:00:00Z");
  utimesSync(path, later, later);
  assert.equal((await sessions.links(["thread-1"])).get("thread-1"), link(uuid(7)), "a changed mtime is re-read");

  rmSync(path);
  assert.deepEqual(await sessions.links(["thread-1"]), new Map(), "a vanished record drops its link");

  // The monitor overlays desktop links onto Claude rows; each observation replaces the stored link.
  const recordPath = record("claude-row", uuid(8));
  const state = new State(join(dir, "state.db"), { now: () => "2026-06-09T10:10:00.000Z", activeWindow: "1d" });
  let message = "2026-06-09T10:05:00.000Z";
  const monitor = new SessionMonitor(state, {
    scan: async () => [
      fakeScanRow({ id: "claude-row", source: "claude", lastMessageAt: message }),
      fakeScanRow({ id: "codex-row", source: "codex", app: "Codex", lastMessageAt: message, link: "codex://threads/codex-row" }),
    ],
    claudeDesktop: new ClaudeDesktopSessions(root),
  });
  const links = async () => Object.fromEntries((await monitor.poll()).map((row) => [row.id, row.link]));
  assert.deepEqual(await links(), { "claude-row": link(uuid(8)), "codex-row": "codex://threads/codex-row" });
  rmSync(recordPath);
  message = "2026-06-09T10:06:00.000Z";
  assert.deepEqual(await links(), { "claude-row": null, "codex-row": "codex://threads/codex-row" }, "a vanished record clears the stored link");
  monitor.stop();
  state.close();
  console.log("ok - claude desktop sessions: fail-closed index, mtime reparse, vanished records, monitor link overlay");
} finally {
  cleanup();
}

// Owner Operator — read-only access to OpenCode's SQLite session store.
//
// Current OpenCode keeps sessions in `opencode.db` inside its data directory, the same directory
// that holds the legacy one-JSON-per-record `storage/` tree
// ([database path](https://github.com/anomalyco/opencode/blob/d284e7ce17d0a98c80d0bebd5cc6dce2dbdd5f74/packages/cli/src/database-path.ts#L4-L13)).
// The database holds two generations: v1 sessions in `session` with `message` + `part` rows, and
// v2 sessions in `session_v2` with `session_message` rows. A session migrated to v2 keeps a copy
// of its history in the v1 tables, so the v2 row is authoritative for any id it holds.
// Plain ESM so the zero-install scan and the search wrapper run it directly. Opens read-only.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The database beside a configured OpenCode `storage` store root (both live in the data dir). */
export function openCodeDatabasePath(storeRoot) {
  return join(dirname(storeRoot), "opencode.db");
}

/** A read-only handle, or null when the file, `node:sqlite`, or a known session table is missing. */
export function openOpenCodeDatabase(path) {
  if (!existsSync(path)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite")); } catch { return null; }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const v1 = ["session", "message", "part"].every((name) => tables.has(name));
    const v2 = ["session_v2", "session_message"].every((name) => tables.has(name));
    if (!v1 && !v2) { db.close(); return null; }
    return { db, v1, v2, close: () => db.close() };
  } catch {
    try { db?.close(); } catch { /* already closed */ }
    return null;
  }
}

/** Sessions updated at or after `since` (epoch ms): `{ id, directory, title, createdAt, updatedAt }`. */
export function listOpenCodeSessions(handle, since = 0) {
  const columns = "id, directory, title, time_created AS createdAt, time_updated AS updatedAt";
  const v2 = handle.v2 ? handle.db.prepare(`SELECT ${columns} FROM session_v2 WHERE time_updated >= ?`).all(since) : [];
  const v1 = handle.v1
    ? handle.db.prepare(`SELECT ${columns} FROM session WHERE time_updated >= ?${handle.v2 ? " AND id NOT IN (SELECT id FROM session_v2)" : ""}`).all(since)
    : [];
  return [...v2, ...v1].map((row) => ({ ...row, title: row.title ?? null }));
}

/** A session's user and assistant turns in order: `{ role, text, ts, completed }`. `completed` is
 * false for an assistant message OpenCode has not finished (still streaming or running tools). An
 * assistant message that failed before writing text carries its error message as its text, so a
 * failed turn reads as the agent's answer rather than an unanswered prompt. */
export function readOpenCodeMessages(handle, sessionId) {
  const inV2 = handle.v2 && handle.db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(sessionId);
  const out = [];
  if (inV2) {
    for (const row of handle.db.prepare(
      "SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant', 'idle') ORDER BY seq",
    ).all(sessionId)) {
      const data = parse(row.data);
      if (!data) continue;
      // An `idle` row ends the turn: it closes an assistant message an interrupt left without
      // time.completed. A turn that failed before the model answered (e.g. `provider.no-route`)
      // records only this row, so its error is the answer.
      if (row.type === "idle") {
        const last = out.at(-1);
        if (last?.role === "assistant") last.completed = true;
        else if (last && data.outcome === "failed") {
          out.push({ role: "assistant", text: errorText(data.error?.message), ts: data.time?.created ?? 0, completed: true });
        }
        continue;
      }
      const text = row.type === "user"
        ? (typeof data.text === "string" ? data.text : "")
        : (Array.isArray(data.content) ? data.content : [])
          .filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      out.push({ role: row.type, text: text.trim() ? text : errorText(data.error?.message), ts: data.time?.created ?? 0, completed: data.time?.completed != null });
    }
    return out;
  }
  if (!handle.v1) return out;
  const parts = handle.db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id");
  for (const row of handle.db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(sessionId)) {
    const message = parse(row.data);
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = parts.all(row.id).map((part) => parse(part.data))
      .filter((part) => part?.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored)
      .map((part) => part.text).join("\n");
    out.push({ role: message.role, text: text.trim() ? text : errorText(message.error?.data?.message), ts: message.time?.created ?? 0, completed: message.time?.completed != null });
  }
  return out;
}

function errorText(message) {
  return typeof message === "string" && message.trim() ? `Error: ${message}` : "";
}

function parse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

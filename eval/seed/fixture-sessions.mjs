import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_OPERATOR_SESSIONS, SESSIONS } from "../fixtures/sessions.mjs";
import { ThreadDb } from "../../src/state/database.ts";

/** Materialize fixture evidence and index without changing auth, policy, or process state.
 * The caller owns the disposable root and OO home. Existing unrelated files are preserved.
 */
export function seedFixtureSessions({ root, ooHome, now = Date.now() }) {
  const TRANSCRIPTS = join(root, "transcripts");
  const HOME = ooHome;
  const at = (offsetMin) => new Date(now - offsetMin * 60_000).toISOString();
  mkdirSync(join(TRANSCRIPTS, "codex"), { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const transcriptPaths = new Map();
  for (const s of SESSIONS) {
    const lines = [];
    if (s.source === "claude") {
      for (const m of s.messages) {
        lines.push(JSON.stringify({
          type: m.role,
          message: { role: m.role, content: [{ type: "text", text: m.text }], stop_reason: m.stop ?? null },
          cwd: s.cwd,
          sessionId: s.id,
          timestamp: at(m.offsetMin),
        }));
      }
      const dir = join(TRANSCRIPTS, "claude", s.slug);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${s.id}.jsonl`);
      writeFileSync(file, lines.join("\n") + "\n");
      transcriptPaths.set(s.id, file);
    } else {
      const first = Math.max(...s.messages.map((m) => m.offsetMin));
      lines.push(JSON.stringify({ timestamp: at(first + 1), type: "session_meta", payload: { id: s.id, cwd: s.cwd, originator: "codex_cli" } }));
      for (const m of s.messages) {
        if (m.role === "user") lines.push(JSON.stringify({ timestamp: at(m.offsetMin), type: "event_msg", payload: { type: "task_started" } }));
        lines.push(JSON.stringify({
          timestamp: at(m.offsetMin),
          type: "response_item",
          payload: { type: "message", role: m.role, content: [{ type: "output_text", text: m.text }] },
        }));
        if (m.role === "assistant") lines.push(JSON.stringify({ timestamp: at(m.offsetMin), type: "event_msg", payload: { type: "task_complete" } }));
      }
      const file = join(TRANSCRIPTS, "codex", `${s.id}.jsonl`);
      writeFileSync(file, lines.join("\n") + "\n");
      transcriptPaths.set(s.id, file);
    }
  }

  const ownerOperatorSessions = join(HOME, "sessions");
  mkdirSync(ownerOperatorSessions, { recursive: true });
  for (const s of OWNER_OPERATOR_SESSIONS) {
    const first = Math.max(...s.messages.map((message) => message.offsetMin));
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: s.id, timestamp: at(first + 1), cwd: s.cwd }),
      ...s.messages.map((message, index) => JSON.stringify({
        type: "message",
        id: `m${index + 1}`,
        parentId: index === 0 ? null : `m${index}`,
        timestamp: at(message.offsetMin),
        message: { role: message.role, content: [{ type: "text", text: message.text }] },
      })),
    ];
    writeFileSync(join(ownerOperatorSessions, `${s.id}.jsonl`), lines.join("\n") + "\n");
  }

  let stamp = new Date(now).toISOString();
  const db = new ThreadDb(join(HOME, "state.db"), { now: () => stamp });
  try {
    for (const s of SESSIONS) {
      const created = Math.max(...s.messages.map((m) => m.offsetMin));
      const lastMsg = Math.min(...s.messages.map((m) => m.offsetMin));
      stamp = at(created);
      db.recordScan({
        id: s.id,
        repo: s.repo,
        project: s.cwd,
        app: s.source === "claude" ? "Claude CLI" : "Codex CLI",
        source: s.source,
        transcriptPath: transcriptPaths.get(s.id),
        state: "working",
        createdAt: at(created),
        lastActiveAt: at(Math.min(...s.messages.map((m) => m.offsetMin))),
        lastMessageAt: at(Math.min(...s.messages.map((m) => m.offsetMin))),
      });
      for (const t of s.detailsHistory) {
        stamp = at(t.offsetMin);
        db.appendModelDetails(
          s.id,
          { priority: t.priority, topic: t.topic, statusSummary: t.statusSummary },
          at(t.throughOffsetMin ?? lastMsg),
        );
      }
      stamp = at(lastMsg);
      db.recordScan({
        id: s.id,
        repo: s.repo,
        project: s.cwd,
        app: s.source === "claude" ? "Claude CLI" : "Codex CLI",
        source: s.source,
        transcriptPath: transcriptPaths.get(s.id),
        state: s.state,
        createdAt: at(created),
        lastActiveAt: at(lastMsg),
        lastMessageAt: at(lastMsg),
      });
    }
  } finally {
    db.close();
  }
  return {
    transcriptPaths,
    sessionSources: {
      disable: ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"],
      add: [
        { source: "claude", root: join(TRANSCRIPTS, "claude") },
        { source: "codex", root: join(TRANSCRIPTS, "codex") },
      ],
    },
  };
}

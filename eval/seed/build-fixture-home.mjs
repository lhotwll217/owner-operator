// Build the eval sandbox: fixture transcripts + a seeded OO_HOME, both under
// $TMPDIR/oo-eval-sandbox (outside the repo), so a subject's session sources never point
// at repo files. (cases.yaml is still reachable via the read tool in principle — nothing
// steers a subject there, but the isolation is by convention, not structural.)
//
//   npx tsx eval/seed/build-fixture-home.mjs        (idempotent; prints the sandbox path)
//
// Layout under $TMPDIR/oo-eval-sandbox:
//   transcripts/claude/<project-slug>/<id>.jsonl    claude-format sessions
//   transcripts/codex/<id>.jsonl                    codex-format sessions
//   home/                                           OO_HOME for the subject under eval:
//     session_sources.json                          defaults disabled, fixture roots added
//     settings.json                                 activeWindow wide enough for the fixtures
//     threads.db                                    snapshot + versioned details history
//
// Timestamps come from fixtures/sessions.mjs offsets, materialized relative to NOW — so
// "active today" behaves identically on every run. Run again to re-stamp before an eval.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSIONS } from "../fixtures/sessions.mjs";
import { ThreadDb } from "../../src/gateway/threads-db.ts";

const MIN = 60 * 1000;
const now = Date.now();
const at = (offsetMin) => new Date(now - offsetMin * MIN).toISOString();

export const SANDBOX = join(tmpdir(), "oo-eval-sandbox");
const TRANSCRIPTS = join(SANDBOX, "transcripts");
const HOME = join(SANDBOX, "home");

rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(TRANSCRIPTS, "codex"), { recursive: true });
mkdirSync(HOME, { recursive: true });

// ---- transcripts -------------------------------------------------------------------
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
    writeFileSync(join(dir, `${s.id}.jsonl`), lines.join("\n") + "\n");
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
    writeFileSync(join(TRANSCRIPTS, "codex", `${s.id}.jsonl`), lines.join("\n") + "\n");
  }
}

// ---- OO_HOME: sources, settings, seeded db ------------------------------------------
writeFileSync(join(HOME, "session_sources.json"), JSON.stringify({
  disable: ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"],
  add: [
    { source: "claude", root: join(TRANSCRIPTS, "claude") },
    { source: "codex", root: join(TRANSCRIPTS, "codex") },
  ],
}, null, 2));
writeFileSync(join(HOME, "settings.json"), JSON.stringify({ activeWindow: "14d" }, null, 2));

// Details history first (versions with real created_at spacing), then the snapshot so
// current state matches the newest version — the same order the poller produces.
let stamp = new Date(now).toISOString();
const db = new ThreadDb(join(HOME, "threads.db"), { now: () => stamp });
for (const s of SESSIONS) {
  const created = Math.max(...s.messages.map((m) => m.offsetMin));
  stamp = at(created);
  db.recordScan({
    id: s.id,
    repo: s.repo,
    app: s.source === "claude" ? "Claude CLI" : "Codex CLI",
    source: s.source,
    state: "working",
    createdAt: at(created),
    lastActiveAt: at(Math.min(...s.messages.map((m) => m.offsetMin))),
  });
  for (const t of s.detailsHistory) {
    stamp = at(t.offsetMin);
    db.appendModelDetails(s.id, { priority: t.priority, topic: t.topic, summary: t.summary, nextSteps: t.nextSteps });
  }
}
db.saveSnapshot({
  polledAt: new Date(now).toISOString(),
  threads: SESSIONS.map((s) => {
    const latest = s.detailsHistory[s.detailsHistory.length - 1];
    const lastMsg = Math.min(...s.messages.map((m) => m.offsetMin));
    return {
      id: s.id,
      source: s.source,
      repo: s.repo,
      app: s.source === "claude" ? "Claude CLI" : "Codex CLI",
      topic: latest.topic,
      state: s.state,
      lastActive: "recently",
      createdAt: at(Math.max(...s.messages.map((m) => m.offsetMin))),
      lastMessageAt: at(lastMsg),
      firstSeen: at(Math.max(...s.messages.map((m) => m.offsetMin))),
    };
  }),
});
db.close();

console.log(SANDBOX);

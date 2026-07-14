// Build the eval sandbox: fixture transcripts + a seeded OO_HOME, both under
// $TMPDIR/oo-eval-sandbox/<run-id> (outside the repo), so concurrent runs never share state
// and a subject's session sources never point at repo files. The eval directory itself is
// blacklisted for subjects, making cases.yaml
// and fixture ground truth structurally unreadable while leaving the shipped skill loadable.
//
//   npx tsx eval/seed/build-fixture-home.mjs        (idempotent; prints the sandbox path)
//
// Layout under $TMPDIR/oo-eval-sandbox/<run-id>:
//   transcripts/claude/<project-slug>/<id>.jsonl    claude-format sessions
//   transcripts/codex/<id>.jsonl                    codex-format sessions
//   home/                                           OO_HOME for the subject under eval:
//     session_sources.json                          defaults disabled, fixture roots added
//     settings.json                                 activeWindow wide enough for the fixtures
//     state.db                                      versioned state + details history
//
// Timestamps come from fixtures/sessions.mjs offsets, materialized relative to NOW — so
// "active today" behaves identically on every run. Run again to re-stamp before an eval.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markOnboarded } from "@owner-operator/core";
import { assertEvalSandboxPath, evalSandboxPath } from "../sandbox.mjs";
import { SESSIONS } from "../fixtures/sessions.mjs";
import { ThreadDb } from "../../src/state/database.ts";
import { repoRoot } from "../../src/shared/repo-root.ts";

const MIN = 60 * 1000;
const now = Date.now();
const at = (offsetMin) => new Date(now - offsetMin * MIN).toISOString();

export const SANDBOX = process.env.OO_EVAL_SANDBOX
  ? assertEvalSandboxPath(process.env.OO_EVAL_SANDBOX)
  : evalSandboxPath("manual");
const TRANSCRIPTS = join(SANDBOX, "transcripts");
const HOME = join(SANDBOX, "home");

rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(TRANSCRIPTS, "codex"), { recursive: true });
mkdirSync(HOME, { recursive: true });

// ---- transcripts -------------------------------------------------------------------
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

// ---- OO_HOME: sources, settings, seeded db ------------------------------------------
writeFileSync(join(HOME, "session_sources.json"), JSON.stringify({
  disable: ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"],
  add: [
    { source: "claude", root: join(TRANSCRIPTS, "claude") },
    { source: "codex", root: join(TRANSCRIPTS, "codex") },
  ],
}, null, 2));
writeFileSync(join(HOME, "settings.json"), JSON.stringify({ activeWindow: "14d" }, null, 2));
writeFileSync(join(HOME, "blacklist.json"), JSON.stringify({ paths: [join(repoRoot, "eval")], repos: [] }, null, 2));
markOnboarded(HOME, { via: "eval-fixture" });

// Details history first (versions with real created_at spacing), then the final transcript
// observation so current state matches the fixture.
let stamp = new Date(now).toISOString();
const db = new ThreadDb(join(HOME, "state.db"), { now: () => stamp });
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
      { priority: t.priority, topic: t.topic, summary: t.summary, nextSteps: t.nextSteps },
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
db.close();

console.log(SANDBOX);

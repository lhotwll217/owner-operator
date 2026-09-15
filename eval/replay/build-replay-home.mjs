// Materialize one replay environment from a captured slice (capture-session-slice.mjs).
//
//   node eval/replay/build-replay-home.mjs --capture <dir> --root <sandbox run dir>
//
// The capture is immutable; this rebases it onto the current clock so relative timing — and
// therefore the working/idle/needs-you the resolver derives — reproduces on every run. Both
// the before and after run rebase the same capture, so their inputs stay matched.
//
// Rebasing shifts every stored instant by `delta = now - manifest.anchor`: transcript
// `timestamp` fields, transcript file modification times (the scan's candidate filter), and
// every timestamp column in the state database. Transcript file NAMES keep their captured
// stamps, exactly as production leaves them.
//
// Writes only under the sandbox run directory; the capture and live state are read-only.

import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, relative, resolve } from "node:path";
import { assertEvalSandboxPath } from "../sandbox.mjs";

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
const TIMESTAMP_FIELD = new RegExp(`("timestamp"\\s*:\\s*")(${ISO.source})(")`, "g");
const ANY_ISO = new RegExp(ISO.source, "g");

const TIME_COLUMNS = {
  threads: ["created_at", "first_seen_at", "last_seen_at", "last_active_at", "last_message_at", "last_checked_at", "enriched_through_message_at"],
  thread_details: ["created_at"],
  agent_runs: ["created_at", "started_at", "finished_at", "last_activity_at"],
  worktrees: ["created_at"],
  thread_worktrees: ["selected_at"],
  schedules: ["created_at", "updated_at", "next_run_at", "deleted_at"],
  schedule_runs: ["created_at", "scheduled_for", "started_at", "finished_at"],
  schedule_event_watermarks: ["last_message_at"],
};
// Embedded child evidence is compared against live thread rows, so it shifts with them.
const JSON_TIME_COLUMNS = { threads: ["enriched_children"] };

export function shiftIso(value, deltaMs) {
  return new Date(Date.parse(value) + deltaMs).toISOString();
}

export function buildReplayHome({ capture, root, activeWindow, now = Date.now() }) {
  const captureDir = resolve(capture);
  const runRoot = assertEvalSandboxPath(root);
  const manifest = JSON.parse(readFileSync(join(captureDir, "manifest.json"), "utf8"));
  const stores = JSON.parse(readFileSync(join(captureDir, "stores.json"), "utf8"));
  const delta = now - Date.parse(manifest.anchor);

  const userHome = join(runRoot, "user-home");
  const ooHome = join(userHome, ".owner-operator");
  const transcripts = join(runRoot, "transcripts");
  mkdirSync(ooHome, { recursive: true });

  // The product's own history store is implicit at <ooHome>/sessions; every other store
  // becomes a configured root so the scan resolves the captured transcript format.
  const productStore = Object.entries(stores).find(([key]) => key.endsWith("-.owner-operator-sessions"))?.[0];
  const added = [];
  let files = 0;
  for (const [key, format] of Object.entries(stores)) {
    const from = join(captureDir, "transcripts", key);
    const to = key === productStore ? join(ooHome, "sessions") : join(transcripts, key);
    mkdirSync(to, { recursive: true });
    if (key !== productStore) added.push({ source: format, root: to });
    for (const entry of readdirSync(from, { recursive: true })) {
      const source = join(from, String(entry));
      if (!source.endsWith(".jsonl") && !source.endsWith(".ndjson")) continue;
      if (!statSync(source).isFile()) continue;
      const destination = join(to, relative(from, source));
      mkdirSync(join(destination, ".."), { recursive: true });
      const rebased = readFileSync(source, "utf8")
        .replace(TIMESTAMP_FIELD, (_match, open, value, close) => `${open}${shiftIso(value, delta)}${close}`);
      writeFileSync(destination, rebased);
      const stamp = new Date(statSync(source).mtimeMs + delta);
      utimesSync(destination, stamp, stamp);
      files++;
    }
  }

  // ---- state database -----------------------------------------------------------------
  const dbPath = join(ooHome, "state.db");
  cpSync(join(captureDir, "state.db"), dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  for (const [table, columns] of Object.entries(TIME_COLUMNS)) {
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const column of columns.filter((name) => present.has(name))) {
      const rows = db.prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const { rid, value } of rows) update.run(shiftIso(String(value), delta), rid);
    }
  }
  for (const [table, columns] of Object.entries(JSON_TIME_COLUMNS)) {
    for (const column of columns) {
      const rows = db.prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const { rid, value } of rows) {
        update.run(String(value).replace(ANY_ISO, (match) => shiftIso(match, delta)), rid);
      }
    }
  }
  db.exec("COMMIT");
  const span = db.prepare("SELECT MIN(last_message_at) lo, MAX(last_message_at) hi, COUNT(*) n FROM threads").get();
  db.close();

  // ---- owner configuration ------------------------------------------------------------
  writeFileSync(join(ooHome, "session_sources.json"), `${JSON.stringify({
    disable: ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"],
    add: added,
  }, null, 2)}\n`);
  writeFileSync(join(ooHome, "settings.json"), `${JSON.stringify({ activeWindow, permissionMode: "allow" }, null, 2)}\n`);
  copyFileSync(join(captureDir, "manifest.json"), join(runRoot, "capture-manifest.json"));

  const replay = {
    capture: captureDir,
    capturedAt: manifest.capturedAt,
    anchor: manifest.anchor,
    rebasedAt: new Date(now).toISOString(),
    deltaMs: delta,
    activeWindow,
    transcriptFiles: files,
    threads: span.n,
    rebasedSpan: { earliest: span.lo, latest: span.hi },
    ooHome,
    userHome,
    transcriptRoots: added,
    productHistoryRoot: join(ooHome, "sessions"),
  };
  writeFileSync(join(runRoot, "replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
  return replay;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    const value = index === -1 ? undefined : args[index + 1];
    return value && !value.startsWith("--") ? value : fallback;
  };
  const capture = flag("capture", "") || (() => { throw new Error("--capture is required"); })();
  const root = flag("root", "") || (() => { throw new Error("--root is required"); })();
  console.log(JSON.stringify(buildReplayHome({ capture, root, activeWindow: flag("active-window", "36h") }), null, 2));
}

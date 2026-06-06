#!/usr/bin/env node
// get-active-threads — deterministic, dependency-free scan of local CLI agent sessions.
//
// Reads Claude Code (~/.claude/projects) and Codex (~/.codex/sessions) session files,
// finds recently-active threads, and prints a COMPACT digest: topic, light metadata, and
// message "bookends" (first few + last few user-facing turns) so an agent can triage
// "what's ongoing" WITHOUT loading full transcripts into an expensive model.
//
// Usage:
//   node get-active-threads.mjs [--since today|7d|2026-06-04] [--bookends 4]
//                               [--limit 40] [--all] [--json] [--truncate 280]
//   (--last is accepted as an alias for --bookends)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : def;
};
const has = (name) => args.includes(`--${name}`);

const sinceArg = String(val("since", "today"));
const bookN = parseInt(val("bookends", val("last", "4")), 10); // first N + last N turns
const limit = parseInt(val("limit", "40"), 10);
const truncate = parseInt(val("truncate", "280"), 10);
const includeAll = has("all");
const asJson = has("json");

// ---------- time window ----------
function cutoffFrom(s) {
  const now = Date.now();
  if (s === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const m = /^(\d+)d$/.exec(s);
  if (m) return now - parseInt(m[1], 10) * 86400000;
  const d = new Date(s + "T00:00:00");
  if (!isNaN(d.getTime())) return d.getTime();
  const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime();
}
const cutoff = cutoffFrom(sinceArg);

// ---------- collect candidate files (mtime within window) ----------
function walk(dir, out) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}
const roots = [
  { root: join(homedir(), ".claude", "projects"), source: "claude" },
  { root: join(homedir(), ".codex", "sessions"), source: "codex" },
];
const candidates = [];
for (const { root, source } of roots) {
  if (!existsSync(root)) continue;
  const files = [];
  walk(root, files);
  for (const f of files) {
    let st; try { st = statSync(f); } catch { continue; }
    if (st.mtimeMs >= cutoff) candidates.push({ file: f, source, mtime: st.mtimeMs });
  }
}

// ---------- helpers ----------
const clip = (s, n = truncate) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
// Injected/boilerplate turns that aren't real user-facing conversation.
const NOISE = [
  /^Respond directly to the user'?s prompt/i, /^<system_instruction>/i, /^<environment_context>/i,
  /^<user_instructions>/i, /^<user_action>/i, /^<turn_aborted>/i, /^# AGENTS\.md/i,
  /Use the [\w-]+ worker role/i, /^Review the current code changes/i, /^Remember this token/i,
  /^\(Empty session\)/i, /A session-scoped Stop hook is now active/i,
];
const isBoiler = (t) => !t || !t.trim() || NOISE.some((re) => re.test(t.trim()));

function claudeText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ");
  return "";
}

// Which GUI the thread lives in. A session spawned in a Conductor worktree belongs to
// Conductor — that's where the branch/worktree lives — even if Codex/Claude is the agent.
// So Conductor is checked FIRST, before the underlying source.
function detectUi(source, cwd, entrypoint) {
  if (cwd && cwd.includes("/conductor/workspaces/")) return "Conductor";
  if (source === "codex") return "Codex";
  if (entrypoint === "claude-desktop") return "Claude Code (desktop)";
  if (entrypoint === "sdk-ts") return "SDK";
  return source === "claude" ? "Claude Code" : source;
}

// GUI deep-link — ONLY when it opens the GUI the session actually lives in:
//  - Codex session run on its own        → codex://threads/<id>  ✅ (verified live)
//  - Codex session spawned in Conductor   → the worktree lives in Conductor (which has NO
//    deep-link), so a codex:// link would point at the wrong GUI → no link.
//  - Claude (desktop/Conductor)           → no confirmed deep-link → no link.
function guiLink(source, id, cwd) {
  if (cwd && cwd.includes("/conductor/workspaces/")) return null; // Conductor-spawned → ties to Conductor, not Codex
  if (source === "codex") return `codex://threads/${id}`;
  return null;
}

const iso = (ms) => new Date(ms).toISOString();

// ---------- parse one session ----------
function parseSession({ file, source, mtime }) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { return null; }
  const msgs = [];                 // substantive text turns: {role, text, ts}
  let project = null, sessionId = null, entrypoint = null, firstTs = 0, lastTs = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }

    const ts = o.timestamp ? Date.parse(o.timestamp) : (o.payload?.timestamp ? Date.parse(o.payload.timestamp) : 0);
    if (ts) { if (!firstTs || ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }

    if (source === "claude") {
      if (!project && o.cwd) project = o.cwd;
      if (!sessionId && o.sessionId) sessionId = o.sessionId;
      if (!entrypoint && o.entrypoint) entrypoint = o.entrypoint;
      if (o.type === "user" || o.type === "assistant") {
        const text = claudeText(o.message?.content);
        if (text && text.trim()) msgs.push({ role: o.type, text, ts });
      }
    } else { // codex
      if (o.type === "session_meta") { project = o.payload?.cwd || project; sessionId = o.payload?.id || sessionId; }
      if (o.type === "response_item" && o.payload?.type === "message") {
        const role = o.payload.role;
        const text = (o.payload.content || []).map((c) => c?.text || "").join(" ");
        if (text && text.trim() && (role === "user" || role === "assistant")) msgs.push({ role, text, ts });
      }
    }
  }

  if (!sessionId) sessionId = basename(file).replace(/\.jsonl$/, "");
  if (!project) project = "(unknown)";
  // Repo name = the leaf folder of the session's cwd (the worktree/repo it lives in).
  const repo = project === "(unknown)" ? "(unknown)" : basename(project);

  // real user-facing conversation (drop injected boilerplate turns)
  const convo = msgs.filter((m) => !isBoiler(m.text));
  if (convo.length === 0) return null;

  const userTurns = convo.filter((m) => m.role === "user");
  const topicMsg = userTurns[0] || convo[0];
  const automated = userTurns.length < 2;

  const lastMsg = convo[convo.length - 1];
  const createdTs = firstTs || mtime;
  const lastMsgTs = lastMsg.ts || lastTs || mtime;

  // bookends: first N + last N real turns (no overlap)
  const shape = (m) => ({ role: m.role, text: clip(m.text), at: m.ts ? iso(m.ts) : null });
  let first, last, omitted;
  if (convo.length <= bookN * 2) { first = convo.map(shape); last = []; omitted = 0; }
  else { first = convo.slice(0, bookN).map(shape); last = convo.slice(-bookN).map(shape); omitted = convo.length - bookN * 2; }

  return {
    id: sessionId,
    source,
    repo,                                              // Repo Name (leaf folder of cwd)
    ui: detectUi(source, project, entrypoint),         // App the session was made from
    entrypoint: entrypoint || (source === "codex" ? "codex" : null),
    project,
    topic: clip(topicMsg.text, 140),
    messageCount: convo.length,
    userMessages: userTurns.length,
    lastRole: lastMsg.role,
    createdAt: iso(createdTs),
    lastMessageAt: iso(lastMsgTs),
    secondsSinceLastMessage: Math.max(0, Math.round((Date.now() - lastMsgTs) / 1000)),
    automated,
    link: guiLink(source, sessionId, project),
    file,
    bookends: { first, last, omitted },
    _sort: lastMsgTs,
  };
}

let threads = candidates.map(parseSession).filter(Boolean);
if (!includeAll) threads = threads.filter((t) => !t.automated);
threads.sort((a, b) => b._sort - a._sort);
threads = threads.slice(0, limit);
threads.forEach((t) => delete t._sort);

// ---------- output ----------
if (asJson) {
  process.stdout.write(JSON.stringify({ since: sinceArg, count: threads.length, threads }, null, 2) + "\n");
} else {
  const rel = (s) => {
    if (s < 45) return "just now";
    const m = Math.round(s / 60); if (s < 3600) return `${m} minute${m === 1 ? "" : "s"} ago`;
    const h = Math.round(s / 3600); if (s < 86400) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.round(s / 86400); return `${d} day${d === 1 ? "" : "s"} ago`;
  };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = (isoStr) => { const d = new Date(isoStr), n = new Date(); const b = `${MON[d.getMonth()]} ${d.getDate()}`; return d.getFullYear() === n.getFullYear() ? b : `${b}, ${d.getFullYear()}`; };
  const line = (m) => `    ${m.role === "user" ? "you " : "asst"}> ${m.text}`;
  if (threads.length === 0) { console.log(`No active threads since ${sinceArg}.`); process.exit(0); }
  const byProj = new Map();
  for (const t of threads) { if (!byProj.has(t.repo)) byProj.set(t.repo, []); byProj.get(t.repo).push(t); }
  console.log(`# Active threads since ${sinceArg} — ${threads.length} thread(s), newest first\n`);
  for (const [repo, ts] of byProj) {
    console.log(`## ${repo}`);
    for (const t of ts) {
      console.log(`\n● ${t.topic}`);
      // Structured fields the operator triages on. "Last message" is relative-only.
      console.log(`  Repo Name     : ${t.repo}`);
      console.log(`  App           : ${t.ui}`);
      console.log(`  Day created   : ${day(t.createdAt)}`);
      console.log(`  Last message  : ${rel(t.secondsSinceLastMessage)} (${t.lastRole === "user" ? "you spoke last" : "agent spoke last"})`);
      console.log(`  Next          : ${t.lastRole === "user" ? "agent's move — working / left mid-task" : "your move — reply to drive it forward"}`);
      console.log(`  ${t.messageCount} msgs${t.link ? ` · open: ${t.link}` : ""}`);
      for (const m of t.bookends.first) console.log(line(m));
      if (t.bookends.omitted) console.log(`    ⋯ ${t.bookends.omitted} more turns ⋯`);
      for (const m of t.bookends.last) console.log(line(m));
    }
    console.log("");
  }
}

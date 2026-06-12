#!/usr/bin/env node
// get-active-threads — deterministic, zero-install scan of local CLI agent sessions.
//
// Reads Claude Code (~/.claude/projects), Codex (~/.codex/sessions), and Cursor
// (~/.cursor/projects/*/agent-transcripts) session files, finds recently-active threads,
// and prints a COMPACT digest: topic, light metadata (resolved state, origin app, git
// delta), and a sample of each thread's messages (its opening few + most-recent few) so
// an agent can triage "what's ongoing" WITHOUT loading full transcripts into a model.
//
// Raw scan rows are CANDIDATES, not truth: each row is resolved against the owner's
// persisted status store (~/.owner-operator/status.json) via the canonical resolver
// (packages/core/src/resolve.mjs — no npm deps, an in-repo import). Threads the owner
// marked done stay hidden until a newer message wakes them; `--include-done` audits them.
//
// Usage:
//   node get-active-threads.mjs [--since today|7d|2026-06-04] [--sample 4] [--thread <id>]
//                               [--limit 40] [--all] [--include-done] [--json] [--truncate 280]
//   --sample N       keeps the first N + most-recent N messages of each thread
//   --thread <id>    drills into ONE thread (id prefix ok); pair with a bigger --sample to
//                    expand just that thread's ends. (--bookends / --last alias --sample.)
//   --include-done   include threads the owner marked done (--all implies it)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { resolveCandidates } from "../../../packages/core/src/resolve.mjs";
import { loadBlacklist, isBlacklisted, pathSlugs } from "../../../packages/core/src/blacklist.mjs";

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : def;
};
const has = (name) => args.includes(`--${name}`);

const sinceArg = String(val("since", "today"));
// How many messages to keep from each end of a thread (opening N + most-recent N).
const sampleSize = parseInt(val("sample", val("bookends", val("last", "4"))), 10);
// Drill into ONE thread by id (prefix ok). Expands just that thread — pair with a bigger
// --sample — without re-scanning/reprinting everything. Bypasses the automated/limit cuts.
const threadArg = val("thread", val("id", null));
const limit = parseInt(val("limit", "40"), 10);
const truncate = parseInt(val("truncate", "280"), 10);
const includeAll = has("all");
const includeDone = has("include-done") || includeAll;
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

// ---------- privacy blacklist (ABSOLUTE — no flag bypasses it) ----------
// Repos/paths the owner declared off-limits (<ooHome>/blacklist.json). Claude transcript
// files under a blacklisted tree are skipped by their project-dir slug BEFORE a byte is
// read; everything else (Codex/Cursor/worktrees) is dropped post-parse by cwd + repo name.
const ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator");
const blacklist = loadBlacklist(ooHome);
const blockedSlugs = pathSlugs(blacklist);
const slugBlocked = (dirName) => blockedSlugs.some((s) => dirName === s || dirName.startsWith(s + "-"));

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
  { root: join(homedir(), ".cursor", "projects"), source: "cursor" },
];
const candidates = [];
for (const { root, source } of roots) {
  if (!existsSync(root)) continue;
  const files = [];
  walk(root, files);
  for (const f of files) {
    // Cursor's projects dir also holds mcps/terminals — only agent transcripts are sessions.
    if (source === "cursor" && !f.includes("/agent-transcripts/")) continue;
    // Blacklisted tree → skip the file unread (Claude project dirs are cwd slugs).
    if (source === "claude" && slugBlocked(basename(dirname(f)))) continue;
    let st; try { st = statSync(f); } catch { continue; }
    if (st.mtimeMs >= cutoff) candidates.push({ file: f, source, mtime: st.mtimeMs, btime: st.birthtimeMs });
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

// Which GUI the thread lives in — the CANONICAL APP NAMES, a fixed display vocabulary:
// Superset App, Conductor, Claude CLI, Claude App, Codex CLI, Codex App, Cursor. (SDK
// worker sessions — hidden by default — carry an SDK label outside that set.) A session
// spawned in a Superset/Conductor worktree belongs to that GUI — that's where the branch/
// worktree lives — even if Codex/Claude/Cursor is the agent, so the worktree hosts are
// checked FIRST, before the source. Codex refines by its session_meta provenance.
function detectUi(source, cwd, entrypoint, meta = {}) {
  if (cwd && cwd.includes("/.superset/worktrees/")) return "Superset App";
  if (cwd && cwd.includes("/conductor/workspaces/")) return "Conductor";
  if (source === "cursor") return "Cursor";
  if (source === "codex") {
    if (meta.srcHint === "vscode") return "Codex App";
    if (meta.originator === "codex_sdk_ts") return "Codex SDK";
    return "Codex CLI"; // codex_cli_rs and unknown provenance both read as the CLI
  }
  if (entrypoint === "claude-desktop") return "Claude App";
  if (entrypoint === "sdk-ts" || entrypoint === "sdk-cli") return "Claude SDK";
  return source === "claude" ? "Claude CLI" : source;
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

// Cursor encodes the session cwd as a dash-slug directory (/Users/x/dev/app → Users-x-dev-app),
// ambiguous for path segments that themselves contain dashes (ai-backend-api). Reconstruct by
// walking the REAL filesystem: extend each component with more tokens until a path exists.
// Naive join fallback when the directory is gone (deleted worktree). Cached per slug.
const unslugCache = new Map();
function cursorProject(file) {
  const slug = basename(file.split("/agent-transcripts/")[0]);
  if (unslugCache.has(slug)) return unslugCache.get(slug);
  const tokens = slug.split("-");
  const go = (base, i) => {
    if (i === tokens.length) return base;
    let comp = "";
    for (let j = i; j < tokens.length; j++) {
      comp = comp ? `${comp}-${tokens[j]}` : tokens[j];
      const p = `${base}/${comp}`;
      if (existsSync(p)) { const hit = go(p, j + 1); if (hit) return hit; }
    }
    return null;
  };
  const path = go("", 0) ?? `/${tokens.join("/")}`;
  unslugCache.set(slug, path);
  return path;
}

// ---------- git workspace delta (per unique cwd, cached) ----------
// +/- line totals from the repo's base (merge-base with origin's default branch) to the
// WORKING TREE — committed + staged + unstaged in one number. No remote → HEAD (uncommitted
// only). Best-effort fact about the workspace: not a repo / dir gone → no badge.
const diffCache = new Map();
function gitDiffStat(cwd) {
  if (!cwd || cwd === "(unknown)") return null;
  if (diffCache.has(cwd)) return diffCache.get(cwd);
  let stat = null;
  try {
    const git = (...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).toString();
    let base = "HEAD";
    for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
      try { base = git("merge-base", "HEAD", ref).trim(); break; } catch { /* try next ref */ }
    }
    let added = 0, deleted = 0;
    for (const line of git("diff", "--numstat", base).split("\n")) {
      const m = /^(\d+)\t(\d+)\t/.exec(line); // binary files show "-\t-" and are skipped
      if (m) { added += +m[1]; deleted += +m[2]; }
    }
    stat = added || deleted ? { added, deleted } : null;
  } catch { /* not a git repo / no commits / cwd gone */ }
  diffCache.set(cwd, stat);
  return stat;
}

// Resolve the real repo name for a cwd. Normal checkout → its own folder. Git worktree
// (Conductor workspace) → <cwd>/.git is a FILE "gitdir: <repo>/.git/worktrees/<name>", so
// take the repo from that path instead of the worktree codename. Best-effort; falls back
// to the cwd leaf when the dir is gone or not a worktree.
function realRepo(cwd) {
  try {
    const dotGit = join(cwd, ".git");
    if (statSync(dotGit).isFile()) {
      const m = /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(readFileSync(dotGit, "utf8"));
      if (m) return basename(m[1].trim());
    }
  } catch { /* dir gone or not a worktree → fall through */ }
  return basename(cwd);
}

// ---------- parse one session ----------
function parseSession({ file, source, mtime, btime }) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { return null; }
  const msgs = [];                 // substantive text turns: {role, text, ts, stop?}
  let project = null, sessionId = null, entrypoint = null, firstTs = 0, lastTs = 0, lastLifecycle = null;
  let originator = null, srcHint = null;   // codex session_meta provenance (→ detectUi)
  let cursorTail = null;                   // cursor: {role, lastBlock} of the LAST record

  if (source === "cursor") project = cursorProject(file); // cwd lives in the dir slug, not the records

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
        if (o.isMeta) continue; // canonical flag for injected/meta turns (divmgl/clancey, constellos/claude-code)
        const text = claudeText(o.message?.content);
        // stop_reason marks turn boundaries: "tool_use" = mid loop (working); "end_turn" = done.
        if (text && text.trim()) msgs.push({ role: o.type, text, ts, stop: o.message?.stop_reason });
      }
    } else if (source === "cursor") {
      // Cursor CLI transcript: { role, message: { content: [text|tool_use blocks] } } —
      // no timestamps, no ids in the records; identity/time come from the path + file stat.
      if (o.role === "user" || o.role === "assistant") {
        const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
        cursorTail = { role: o.role, lastBlock: blocks[blocks.length - 1]?.type ?? null };
        const text = claudeText(o.message?.content).replace(/<\/?user_query>/g, " ");
        if (text && text.trim()) msgs.push({ role: o.role, text, ts: 0 });
      }
    } else { // codex
      if (o.type === "session_meta") {
        project = o.payload?.cwd || project;
        sessionId = o.payload?.id || sessionId;
        originator = o.payload?.originator || originator;
        srcHint = o.payload?.source || srcHint;
      }
      // Turn lifecycle: task_started (running) vs task_complete / turn_aborted (done) — the
      // terminal signal that the agent yielded control back to the user.
      if (o.type === "event_msg") {
        const pt = o.payload?.type;
        if (pt === "task_started" || pt === "task_complete" || pt === "turn_aborted") lastLifecycle = pt;
      }
      if (o.type === "response_item" && o.payload?.type === "message") {
        const role = o.payload.role;
        const text = (o.payload.content || []).map((c) => c?.text || "").join(" ");
        if (text && text.trim() && (role === "user" || role === "assistant")) msgs.push({ role, text, ts });
      }
    }
  }

  if (!sessionId) sessionId = basename(file).replace(/\.jsonl$/, "");
  if (!project) project = "(unknown)";
  // Repo name. For a git worktree (e.g. a Conductor workspace) the cwd's leaf is a random
  // codename ("bandung"), so resolve the *real* repo via the worktree's .git pointer.
  const repo = project === "(unknown)" ? "(unknown)" : realRepo(project);

  // real user-facing conversation (drop injected boilerplate turns)
  const convo = msgs.filter((m) => !isBoiler(m.text));
  if (convo.length === 0) return null;

  const userTurns = convo.filter((m) => m.role === "user");
  const topicMsg = userTurns[0] || convo[0];
  // Worker vs interactive by LAUNCH MODE, not message count (battle-tested: AgentWrapper/
  // agent-orchestrator keys off `codex exec` / `claude --headless|-p` / sdk). A session is a
  // worker one-shot — hidden unless --all — when:
  //   • no real (non-boilerplate) user turn survived — e.g. a Codex direct/worker preamble; or
  //   • it ran via the SDK (sdk-ts / sdk-cli); or
  //   • it's a single-turn `cli` session — `claude -p` and Task subagents are
  //     indistinguishable from a brand-new terminal session at one turn, so treat <2 turns as
  //     a one-shot (a real terminal session surfaces on its 2nd turn).
  // Interactive entrypoints (codex, claude-desktop, …) show as soon as they have one real turn.
  const SDK_ENTRYPOINTS = new Set(["sdk-ts", "sdk-cli"]);
  const cliLike = entrypoint === "cli" || (entrypoint == null && source === "claude");
  const automated =
    userTurns.length === 0 ||
    SDK_ENTRYPOINTS.has(entrypoint) ||
    (cliLike && userTurns.length < 2);

  const lastMsg = convo[convo.length - 1];
  const createdTs = firstTs || btime || mtime;
  const lastMsgTs = lastMsg.ts || lastTs || mtime;

  // Is a turn IN PROGRESS (still reasoning / running tools / streaming)? The last *message*
  // role alone can't tell — an intermediate assistant message looks "done". Use the terminal
  // signal: Codex → last lifecycle is task_started (no completion yet); Cursor → the last
  // record ends on a tool_use block (no yield); Claude → the last assistant message is a
  // tool_use step, not end_turn.
  const lastAsst = [...convo].reverse().find((m) => m.role === "assistant");
  const working = source === "codex"
    ? lastLifecycle === "task_started"
    : source === "cursor"
      ? cursorTail?.role === "assistant" && cursorTail.lastBlock === "tool_use"
      : (lastMsg.role === "assistant" && !!lastAsst && lastAsst.stop === "tool_use");
  // Liveness from the file's last write — catches reasoning/tool events even when they carry no
  // timestamp, so a thinking agent never looks idle.
  const lastActivityTs = Math.max(lastTs || 0, mtime);

  // Keep the opening N + most-recent N real messages (no overlap); count what's skipped.
  // --sample 0 (the poller's metadata-only mode) keeps NONE — slice(-0) would dump the
  // whole tail, so it gets its own branch.
  const shape = (m) => ({ role: m.role, text: clip(m.text), at: m.ts ? iso(m.ts) : null });
  let firstMessages, recentMessages, omittedMessageCount;
  if (sampleSize <= 0) { firstMessages = []; recentMessages = []; omittedMessageCount = convo.length; }
  else if (convo.length <= sampleSize * 2) { firstMessages = convo.map(shape); recentMessages = []; omittedMessageCount = 0; }
  else { firstMessages = convo.slice(0, sampleSize).map(shape); recentMessages = convo.slice(-sampleSize).map(shape); omittedMessageCount = convo.length - sampleSize * 2; }

  const diff = gitDiffStat(project === "(unknown)" ? null : project);

  return {
    id: sessionId,
    source,
    repo,                                              // Repo Name (leaf folder of cwd)
    ui: detectUi(source, project, entrypoint, { originator, srcHint }), // App the session came from
    entrypoint: entrypoint || (source === "codex" ? "codex" : null),
    project,
    ...(diff ? { diffAdded: diff.added, diffDeleted: diff.deleted } : {}),
    topic: clip(topicMsg.text, 140),
    messageCount: convo.length,
    userMessages: userTurns.length,
    lastRole: lastMsg.role,
    createdAt: iso(createdTs),
    lastMessageAt: iso(lastMsgTs),
    secondsSinceCreated: Math.max(0, Math.round((Date.now() - createdTs) / 1000)),
    secondsSinceLastMessage: Math.max(0, Math.round((Date.now() - lastMsgTs) / 1000)),
    secondsSinceActivity: Math.max(0, Math.round((Date.now() - lastActivityTs) / 1000)),
    working,                                           // a turn is in progress (reasoning/tools)
    automated,
    link: guiLink(source, sessionId, project),
    file,
    firstMessages,          // earliest messages in the thread (array)
    recentMessages,         // most-recent messages in the thread (array)
    omittedMessageCount,    // messages skipped between the two ends
    _sort: lastMsgTs,
  };
}

let threads = candidates.map(parseSession).filter(Boolean);
// Blacklist, second layer: cwd + resolved repo name — catches Codex/Cursor sessions and
// worktrees of a blacklisted repo living elsewhere. Applies before --thread/--all/limit:
// no flag reaches a blacklisted thread.
threads = threads.filter((t) => !isBlacklisted(blacklist, { cwd: t.project, repo: t.repo }));
// One thread per session id: collapse subagent/sidechain transcripts (Task tool, resumed
// sessions) into their parent, keeping the richest (most user turns → most messages → most
// recent). A real session and its subagents share an id, so this de-noises without dropping
// real threads.
const byId = new Map();
for (const t of threads) {
  const p = byId.get(t.id);
  const richer = !p || t.userMessages > p.userMessages
    || (t.userMessages === p.userMessages && (t.messageCount > p.messageCount
      || (t.messageCount === p.messageCount && t._sort > p._sort)));
  if (richer) byId.set(t.id, t);
}
threads = [...byId.values()];

// Join candidates with the owner's persisted status store: the canonical resolver
// annotates each row's resolved `state` and drops rows the owner marked done (until a
// newer message wakes them). `--thread` drill-ins bypass the drop — an explicit look at
// one thread should always answer — but still carry the resolved state.
let persisted = [];
try { persisted = JSON.parse(readFileSync(join(ooHome, "status.json"), "utf8")).threads ?? []; } catch { /* no owner state yet → all candidates pass */ }
threads = resolveCandidates(threads, persisted, { includeDone: includeDone || !!threadArg });

if (threadArg) {
  // Single-thread drill-in: match by full or prefix id (or file basename); keep it even
  // if it's an automated one-shot, and don't apply the limit.
  threads = threads.filter((t) => t.id === threadArg || t.id.startsWith(threadArg) || basename(t.file).startsWith(threadArg));
} else if (!includeAll) {
  threads = threads.filter((t) => !t.automated);
}
threads.sort((a, b) => b._sort - a._sort);
if (!threadArg) threads = threads.slice(0, limit);
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
  const line = (m) => `    ${m.role === "user" ? "you " : "asst"}> ${m.text}`;
  if (threads.length === 0) { console.log(`No active threads since ${sinceArg}.`); process.exit(0); }
  const byProj = new Map();
  for (const t of threads) { if (!byProj.has(t.repo)) byProj.set(t.repo, []); byProj.get(t.repo).push(t); }
  console.log(`# Active threads since ${sinceArg} — ${threads.length} thread(s), newest first\n`);
  for (const [repo, ts] of byProj) {
    console.log(`## ${repo}`);
    for (const t of ts) {
      console.log(`\n● ${t.topic}`);
      // Structured fields the owner triages on. Times are relative ("2 days ago").
      console.log(`  id            : ${t.id}   (drill in: --thread ${t.id} --sample 15)`);
      console.log(`  Repo Name     : ${t.repo}`);
      console.log(`  App           : ${t.ui}`);
      console.log(`  State         : ${t.state}`);
      if (t.diffAdded != null) console.log(`  Diff          : +${t.diffAdded} -${t.diffDeleted}`);
      console.log(`  Created       : ${rel(t.secondsSinceCreated)}`);
      console.log(`  Last message  : ${rel(t.secondsSinceLastMessage)}`);
      console.log(`  ${t.messageCount} msgs${t.link ? ` · open: ${t.link}` : ""}`);
      for (const m of t.firstMessages) console.log(line(m));
      if (t.omittedMessageCount) console.log(`    ⋯ ${t.omittedMessageCount} more messages ⋯`);
      for (const m of t.recentMessages) console.log(line(m));
    }
    console.log("");
  }
}

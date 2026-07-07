#!/usr/bin/env node
// scan-active-transcripts — deterministic, zero-install scan of local CLI agent sessions.
//
// Reads KNOWN_SESSION_SOURCES (canonical list in packages/core/src/session-sources.mjs),
// finds recently-active threads,
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
//   node scan-active-transcripts.mjs [--since 24h|7d|today|2026-06-04] [--sample 4] [--thread <id>]
//      --since default = owner's settings.json `activeWindow` (rolling "1d" if unset)
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
import { loadSessionSources } from "../../../packages/core/src/session-sources.mjs";
import { loadGuiHosts, guiHostForCwd, interactiveHost } from "../../../packages/core/src/gui-hosts.mjs";
import { loadActiveWindow, parseWindowMs } from "../../../packages/core/src/settings.mjs";

const args = process.argv.slice(2);
const val = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : def;
};
const has = (name) => args.includes(`--${name}`);

// ooHome holds the owner's config (settings, blacklist, session sources, GUI hosts).
const ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator");
// Default window comes from owner settings (a rolling "1d" unless configured) — NOT calendar
// "today", so a thread used late last night is still active this morning. Configurable in
// <ooHome>/settings.json (later: onboarding). An explicit --since still overrides per-run.
const sinceArg = String(val("since", null) ?? loadActiveWindow(ooHome));
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
// The window grammar (Nh/Nd rolling, calendar "today", ISO date) lives in core (parseWindowMs)
// so the settings validator and this cutoff can't drift. An unparseable --since falls back to
// calendar-today as a last resort.
const cutoff = parseWindowMs(sinceArg, Date.now())
  ?? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();

// ---------- privacy blacklist (ABSOLUTE — no flag bypasses it) ----------
// Repos/paths the owner declared off-limits (<ooHome>/blacklist.json). Claude transcript
// files under a blacklisted tree are skipped by their project-dir slug BEFORE a byte is
// read; everything else (Codex/Cursor/worktrees) is dropped post-parse by cwd + repo name.
const blacklist = loadBlacklist(ooHome);
// Interactive GUI hosts (Conductor/Superset/PostHog Code, + owner overrides) — one source of
// truth shared by app detection and the launch-mode classifier (see below). Loaded once.
const guiHosts = loadGuiHosts(ooHome);
const blockedSlugs = pathSlugs(blacklist);
const slugBlocked = (dirName) => blockedSlugs.some((s) => dirName === s || dirName.startsWith(s + "-"));

// ---------- collect candidate files (mtime within window) ----------
function walk(dir, out) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    // PostHog Code writes one ACP log per task as `logs.ndjson`; opencode one `.json` per
    // record; everyone else uses `.jsonl`. Per-source filters below keep only real sessions.
    else if (e.isFile() && (e.name.endsWith(".jsonl") || e.name.endsWith(".ndjson") || e.name.endsWith(".json"))) out.push(p);
  }
}
// opencode stores one JSON per record; the per-session INFO file is the thread anchor
// (storage/session/<projectID>/<id>.json, or the legacy storage/session/info/<id>.json).
// Message/part records hang off it — the parser reads those, the scan never lists them.
const opencodeInfoFile = (root, f) => {
  const rel = f.slice(root.length + 1).split("/");
  return rel[0] === "session" && rel.length === 3 && rel[1] !== "message" && rel[1] !== "part";
};
// Built-in defaults + owner overrides (<ooHome>/session_sources.json). Same list the poller
// watches — one source of truth in @owner-operator/core.
const roots = loadSessionSources(ooHome);
const candidates = [];
for (const { root, source } of roots) {
  if (!existsSync(root)) continue;
  const files = [];
  walk(root, files);
  for (const f of files) {
    // Cursor's projects dir also holds mcps/terminals — only agent transcripts are sessions.
    if (source === "cursor" && !f.includes("/agent-transcripts/")) continue;
    // `.json` files are only sessions for opencode — and only its per-session info file
    // (message/part records and the history index are read by the parser, not scanned).
    if (f.endsWith(".json") !== (source === "opencode")) continue;
    if (source === "opencode" && !opencodeInfoFile(root, f)) continue;
    // Antigravity brains hold several .jsonl logs; the digest-friendly transcript is the session.
    if (source === "antigravity" && !f.endsWith("/logs/transcript.jsonl")) continue;
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
// Superset App, Conductor, Claude CLI, Claude App, Codex CLI, Codex App, Cursor, pi,
// opencode, Antigravity, Grok Build. (SDK
// worker sessions — hidden by default — carry an SDK label outside that set.) A session
// spawned in a Superset/Conductor worktree belongs to that GUI — that's where the branch/
// worktree lives — even if Codex/Claude/Cursor is the agent, so the worktree hosts are
// checked FIRST, before the source. Codex refines by its session_meta provenance.
function detectUi(source, cwd, entrypoint, meta = {}) {
  // Worktree GUIs (Superset/Conductor) and source-owned GUIs (PostHog Code) come from the
  // shared host table — cwd marker wins over source, so a worktree's GUI beats its agent.
  const host = interactiveHost(cwd, source, guiHosts);
  if (host) return host.ui;
  if (source === "cursor") return "Cursor";
  if (source === "pi") return "pi";
  if (source === "opencode") return "opencode";
  if (source === "antigravity") return "Antigravity";
  if (source === "grok-build") return "Grok Build";
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
  if (guiHostForCwd(cwd, guiHosts)) return null; // worktree-hosted (Conductor/Superset) → ties to that GUI, not Codex
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

function currentBranch(git) {
  try { return git("branch", "--show-current").trim() || null; } catch { return null; }
}

function mergeBase(git, ref) {
  try { return git("merge-base", "HEAD", ref).trim() || null; } catch { return null; }
}

function gitConfig(git, key) {
  try { return git("config", "--get", key).trim() || null; } catch { return null; }
}

function shortHeadRef(ref) {
  return ref?.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "") || null;
}

function baseRefCandidates(base, remote = "origin") {
  const ref = shortHeadRef(base);
  if (!ref) return [];
  if (ref.startsWith(`${remote}/`) || ref.startsWith("origin/")) return [ref, ref.replace(/^[^/]+\//, "")];
  return [...new Set([remote ? `${remote}/${ref}` : null, `origin/${ref}`, ref].filter(Boolean))];
}

function configuredBaseRefs(git) {
  const current = currentBranch(git);
  if (!current) return [];
  const remote = gitConfig(git, `branch.${current}.remote`) || "origin";
  const branchBase = gitConfig(git, `branch.${current}.base`);
  const ghMergeBase = gitConfig(git, `branch.${current}.gh-merge-base`);
  const mergeRef = shortHeadRef(gitConfig(git, `branch.${current}.merge`));
  const refs = [
    ...baseRefCandidates(branchBase, remote),
    ...baseRefCandidates(ghMergeBase, remote),
  ];
  if (mergeRef && mergeRef !== current) refs.push(...baseRefCandidates(mergeRef, remote));
  return [...new Set(refs)];
}

function remoteHead(git) {
  try {
    return shortHeadRef(git("symbolic-ref", "refs/remotes/origin/HEAD").trim());
  } catch {
    return null;
  }
}

function pickDiffBase(git) {
  const configuredRefs = configuredBaseRefs(git);
  for (const ref of configuredRefs) {
    const base = mergeBase(git, ref);
    if (base) return base;
  }
  // If a configured base exists but is unavailable, or a default branch exists but this
  // branch has no explicit base, do not guess. A hidden badge is better than a misleading
  // "vs main" badge for stacked branches.
  if (configuredRefs.length) return null;
  for (const ref of [...baseRefCandidates(remoteHead(git)), "origin/main", "origin/master"]) {
    if (mergeBase(git, ref)) return null;
  }
  return "HEAD";
}

// ---------- git workspace delta (per unique cwd, cached) ----------
// +/- line totals from the repo's base branch to the WORKING TREE — committed + staged +
// unstaged in one number. Prefer branch-local Git config (`branch.<name>.base`,
// `gh-merge-base`, or a non-self tracking ref). If the branch's base is unknown but a
// default branch exists, omit the badge instead of guessing "main". No branch refs → HEAD
// (uncommitted only). Best-effort fact about the workspace: not a repo / dir gone → no badge.
const diffCache = new Map();
function gitDiffStat(cwd) {
  if (!cwd || cwd === "(unknown)") return null;
  if (diffCache.has(cwd)) return diffCache.get(cwd);
  let stat = null;
  try {
    const git = (...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).toString();
    const base = pickDiffBase(git);
    if (!base) {
      diffCache.set(cwd, null);
      return null;
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

// PostHog Code cloud tasks: when one dies/finishes during provisioning its session log (the only
// thing the scan reads per thread) freezes — no repo line, stuck `in_progress`. The desktop app's
// main.log holds the truth, keyed by the task-run id (== the session dir). Parse it ONCE, lazily,
// into { repo, ended } per run so the posthog-code branch can fill ONLY those gaps — the session
// stream stays primary. Best-effort: missing/rotated log → empty map (every thread unchanged).
let _pcMainLog;
function posthogMainLog() {
  if (_pcMainLog) return _pcMainLog;
  _pcMainLog = new Map();
  let raw;
  try { raw = readFileSync(join(homedir(), ".posthog-code", "logs", "main.log"), "utf8"); }
  catch { return _pcMainLog; }
  const repoByTask = new Map();   // taskId → repo (launch line: "Creating workspace for task X in <path>")
  const taskByRun = new Map();    // taskRunId → taskId (watcher line: "key: 'taskId:taskRunId'")
  const endedRuns = new Set();    // taskRunId whose watcher has stopped → task no longer running
  let prev = "";
  for (const line of raw.split("\n")) {
    const w = /Creating workspace for task ([0-9a-f-]+) in (.+?)(?: \(mode:|$)/.exec(line);
    if (w) { repoByTask.set(w[1], realRepo(w[2].trim())); prev = line; continue; }
    const k = /key: '([0-9a-f-]+):([0-9a-f-]+)'/.exec(line);
    if (k) {
      taskByRun.set(k[2], k[1]);
      if (/Cloud task watcher stopped/.test(prev)) endedRuns.add(k[2]);  // stopped { key } — key is the next line
    }
    prev = line;
  }
  for (const [runId, taskId] of taskByRun) {
    _pcMainLog.set(runId, { repo: repoByTask.get(taskId) ?? null, ended: endedRuns.has(runId) });
  }
  return _pcMainLog;
}

// ---------- parse one session ----------
function parseSession({ file, source, mtime, btime }) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { return null; }
  const msgs = [];                 // substantive text turns: {role, text, ts, stop?}
  let project = null, sessionId = null, entrypoint = null, firstTs = 0, lastTs = 0, lastLifecycle = null;
  let originator = null, srcHint = null;   // codex session_meta provenance (→ detectUi)
  let cursorTail = null;                   // cursor: {role, lastBlock} of the LAST record
  // posthog-code (ACP): assistant narration arrives as many small agent_message chunks per
  // turn — buffer and flush as ONE assistant turn on the next user prompt. Turn completion is
  // a session/prompt RESULT (stopReason); pending requests (no result yet) = a live turn.
  let pcAsst = [], pcAsstTs = 0, pcPromptReq = 0, pcPromptDone = 0;
  const pcFlush = () => { if (pcAsst.length) { msgs.push({ role: "assistant", text: pcAsst.join(" "), ts: pcAsstTs }); pcAsst = []; } };
  // posthog-code cloud/just-launched tasks emit no session/new + conversation until the sandbox
  // is up — only _posthog/* telemetry. Capture repo (from the sandbox-image line), the latest
  // progress label, whether setup is still running, and local-vs-cloud, so the task still surfaces.
  let pcRepo = null, pcEnv = null, pcProgress = null, pcSetupActive = false;
  let agLastStatus = null;                 // antigravity: the last step's status (non-DONE = running)
  let ocAsstOpen = false;                  // opencode: newest assistant msg has no time.completed = streaming

  if (source === "cursor") project = cursorProject(file); // cwd lives in the dir slug, not the records

  // opencode is not line-based: the candidate file is the session INFO record; the turns live
  // in one-JSON-per-message files (with the text in one-JSON-per-part files) hanging off the
  // storage root. Gen-2 keeps them at storage/{message,part}/, the legacy layout under
  // storage/session/{message,part}/. (The newest opencode stores sessions in SQLite —
  // opencode.db — which a zero-install scan can't read; those installs surface nothing here.)
  if (source === "opencode") {
    let info; try { info = JSON.parse(raw); } catch { return null; }
    if (!info || typeof info !== "object" || typeof info.id !== "string") return null;
    sessionId = info.id;
    if (typeof info.directory === "string" && info.directory) project = info.directory;
    if (info.time?.created) firstTs = info.time.created;
    if (info.time?.updated) lastTs = info.time.updated;
    const storageRoot = dirname(dirname(dirname(file))); // …/storage/session/<dir>/<id>.json
    const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
    const list = (dirs) => { for (const d of dirs) { try { return { dir: d, names: readdirSync(d) }; } catch { /* next layout */ } } return null; };
    const msgDir = list([join(storageRoot, "message", sessionId), join(storageRoot, "session", "message", sessionId)]);
    let lastAsstTs = -1;
    for (const name of msgDir?.names.filter((n) => n.endsWith(".json")).sort() ?? []) {
      const m = readJson(join(msgDir.dir, name));
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const mts = m.time?.created ?? 0; // epoch ms
      if (mts) { if (!firstTs || mts < firstTs) firstTs = mts; if (mts > lastTs) lastTs = mts; }
      if (m.role === "assistant" && !project && m.path?.cwd) project = m.path.cwd;
      if (m.role === "assistant" && mts >= lastAsstTs) { lastAsstTs = mts; ocAsstOpen = m.time?.completed == null; }
      const mid = typeof m.id === "string" ? m.id : name.replace(/\.json$/, "");
      const parts = list([join(storageRoot, "part", mid), join(storageRoot, "session", "part", sessionId, mid)]);
      const text = (parts?.names.sort() ?? [])
        .map((p) => readJson(join(parts.dir, p)))
        .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
        .map((p) => p.text).join(" ");
      if (text && text.trim()) msgs.push({ role: m.role, text, ts: mts });
    }
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0)); // file order ≠ turn order — ids/mtimes can interleave
  }

  for (const line of source === "opencode" ? [] : raw.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }

    // Entry timestamps: `timestamp` (claude/codex-event/pi), payload.timestamp (codex),
    // created_at (antigravity steps).
    const tsRaw = o.timestamp ?? o.payload?.timestamp ?? o.created_at;
    const ts = tsRaw ? Date.parse(tsRaw) : 0;
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
    } else if (source === "posthog-code") {
      // PostHog Code logs the ACP (Agent Client Protocol) JSON-RPC stream — one notification
      // per line: { type, timestamp, notification: { method?, id?, params?, result? } }. Ids
      // are reused across method types, so turn completion is keyed off the result SHAPE
      // (stopReason), not id matching.
      const n = o.notification;
      if (!n) continue;
      if (n.method === "session/new") {
        if (n.params?.cwd) project = n.params.cwd;
        if (n.params?._meta?.taskRunId) sessionId = n.params._meta.taskRunId;
        if (n.params?._meta?.environment) pcEnv = n.params._meta.environment;
      } else if (n.method === "session/prompt") {
        pcPromptReq++;
        const text = (n.params?.prompt || []).filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
        if (text && text.trim()) { pcFlush(); msgs.push({ role: "user", text, ts }); } // user_message_chunk duplicates this — prefer the prompt
      } else if (n.method === "session/update") {
        const u = n.params?.update || {};
        if (u.sessionUpdate === "agent_message" && u.content?.type === "text") { pcAsst.push(u.content.text); pcAsstTs = ts; }
      } else if (n.method === "_posthog/console") {
        // Cloud runs clone into a sandbox: "…sandbox base image for <org>/<repo>" is the only
        // place the repo appears before session/new — and it means this is a cloud task.
        const m = /sandbox base image for\s+[\w.-]+\/([\w.-]+)/.exec(n.params?.message || "");
        if (m) { pcRepo = m[1]; pcEnv = pcEnv || "cloud"; }
      } else if (n.method === "_posthog/progress") {
        if (n.params?.label) pcProgress = n.params.label;       // e.g. "Setting up sandbox"
        pcSetupActive = n.params?.status === "in_progress";     // still provisioning → working
      } else if (!n.method && n.result && typeof n.result.stopReason === "string") {
        pcPromptDone++; // a session/prompt completed (end_turn) — only prompt results carry stopReason
      }
    } else if (source === "pi") {
      // pi session (format v3): line 1 is a {type:"session"} header carrying id + cwd; every
      // turn is a {type:"message"} entry wrapping an AgentMessage. Assistant messages carry a
      // stopReason — "toolUse" = mid agent loop, exactly Claude's "tool_use".
      if (o.type === "session") {
        if (o.cwd) project = o.cwd;
        if (o.id) sessionId = o.id;
      } else if (o.type === "message") {
        const m = o.message || {};
        if (m.role === "user" || m.role === "assistant") {
          const text = claudeText(m.content); // same shape: string or [{type:"text",text}] blocks
          if (text && text.trim()) msgs.push({ role: m.role, text, ts, stop: m.stopReason });
        }
      }
    } else if (source === "antigravity") {
      // Antigravity brain transcript: one step per line — {step_index, source, type, status,
      // content, created_at}. USER_EXPLICIT USER_INPUT steps are the owner's prompts;
      // PLANNER_RESPONSE steps are the agent's narration (tool steps like SEARCH_WEB are
      // activity, not conversation). No cwd in the records — identity is the brain/<id> dir.
      if (o.type === "USER_INPUT" && o.source === "USER_EXPLICIT") {
        if (o.content && String(o.content).trim()) msgs.push({ role: "user", text: String(o.content), ts });
      } else if (o.type === "PLANNER_RESPONSE") {
        if (o.content && String(o.content).trim()) msgs.push({ role: "assistant", text: String(o.content), ts });
      }
      if (o.status) agLastStatus = o.status;
    } else if (source === "grok-build") {
      // Grok Build documents WHERE sessions live (~/.grok/sessions, organized by cwd) but not
      // the record shape — parse best-effort: any record that reads as a chat turn (a
      // user/assistant role plus string-or-blocks text, top-level or under `message`).
      // Tighten this once the real shape is pinned down from a live install.
      if (!project && typeof o.cwd === "string") project = o.cwd;
      if (!sessionId && typeof (o.sessionId ?? o.session_id) === "string") sessionId = o.sessionId ?? o.session_id;
      const m = o.message && typeof o.message === "object" ? o.message : o;
      const role = m.role ?? o.type;
      if (role === "user" || role === "assistant") {
        const text = claudeText(m.content ?? m.text);
        if (text && text.trim()) msgs.push({ role, text, ts });
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
  if (source === "posthog-code") pcFlush(); // trailing assistant turn (no later user prompt to flush it)

  // Cursor spawns sub-task agents as `agent-transcripts/<parentId>/subagents/<subId>.jsonl`. Fold those
  // into their parent so a multi-task Cursor run stays ONE "core" thread rather than splitting into one
  // per sub-task — key them to the parent id and let it win the dedup below.
  const cursorSubagent = source === "cursor" && file.includes("/subagents/");
  // posthog-code's session id is the task-run dir, not the `logs.ndjson` leaf; antigravity's
  // the brain/<id> dir above `.system_generated/logs/`; others use the file stem.
  if (!sessionId) {
    if (source === "posthog-code") sessionId = basename(dirname(file));
    else if (source === "antigravity") sessionId = basename(dirname(dirname(dirname(file))));
    else if (cursorSubagent) sessionId = file.split("/agent-transcripts/")[1].split("/")[0];
    else sessionId = basename(file).replace(/\.(jsonl|ndjson)$/, "");
  }
  if (!project) project = "(unknown)";
  // Repo name. For a git worktree (e.g. a Conductor workspace) the cwd's leaf is a random
  // codename ("bandung"), so resolve the *real* repo via the worktree's .git pointer. A
  // posthog-code cloud run has no local cwd — its repo comes from the sandbox-image line.
  let repo = source === "posthog-code" && pcRepo && project === "(unknown)"
    ? pcRepo
    : project === "(unknown)" ? "(unknown)" : realRepo(project);

  // real user-facing conversation (drop injected boilerplate turns)
  const convo = msgs.filter((m) => !isBoiler(m.text));
  if (convo.length === 0) {
    // A launched PostHog Code task that hasn't streamed a turn yet — typically a cloud run
    // still provisioning its sandbox (only _posthog/* telemetry so far). Surface it as a
    // starting thread from that telemetry instead of dropping it until the agent speaks.
    if (source === "posthog-code" && (pcRepo || pcProgress)) {
      convo.push({ role: "assistant", text: pcProgress || "Starting task…", ts: lastTs || mtime });
    } else return null;
  }

  const userTurns = convo.filter((m) => m.role === "user");
  const topicMsg = userTurns[0] || convo[0];
  // Worker vs interactive by LAUNCH MODE, not message count (battle-tested: AgentWrapper/
  // agent-orchestrator keys off `codex exec` / `claude --headless|-p` / sdk). A session is a
  // single-turn worker — hidden unless --all — when:
  //   • no real (non-boilerplate) user turn survived — e.g. a Codex direct/worker preamble; or
  //   • it ran via the SDK (sdk-ts / sdk-cli); or
  //   • it's a single-turn `cli` session — `claude -p` and Task subagents are
  //     indistinguishable from a brand-new terminal session at one turn, so treat <2 turns as
  //     a single-turn worker (a real terminal session surfaces on its 2nd turn).
  // Interactive entrypoints (codex, claude-desktop, …) show as soon as they have one real turn.
  //
  // EXCEPT when an interactive GUI HOST owns the session: Conductor and Superset drive the agent
  // over the SDK, PostHog Code over ACP — the transport is headless but the owner opened the
  // session deliberately, so the rules above would WRONGLY hide it (every Conductor thread was
  // hidden this way until now). A host short-circuits to interactive; `surfaceEmpty` hosts
  // (PostHog Code cloud tasks, no turns yet) surface even empty. The host list lives in
  // @owner-operator/core (gui-hosts) — a new GUI is one entry there, never a per-source patch here.
  const SDK_ENTRYPOINTS = new Set(["sdk-ts", "sdk-cli"]);
  const cliLike = entrypoint === "cli" || (entrypoint == null && source === "claude");
  const host = interactiveHost(project, source, guiHosts);
  const automated = host
    ? (host.surfaceEmpty ? false : userTurns.length === 0)
    : userTurns.length === 0 ||
      SDK_ENTRYPOINTS.has(entrypoint) ||
      (cliLike && userTurns.length < 2);

  const lastMsg = convo[convo.length - 1];
  const createdTs = firstTs || btime || mtime;
  const lastMsgTs = lastMsg.ts || lastTs || mtime;

  // Is a turn IN PROGRESS (still reasoning / running tools / streaming)? The last *message*
  // role alone can't tell — an intermediate assistant message looks "done". Use each source's
  // terminal signal: Codex → last lifecycle is task_started (no completion yet); Cursor → the
  // last record ends on a tool_use block (no yield); Claude/pi → the last assistant message is
  // a tool-use step, not an end of turn.
  const lastAsst = [...convo].reverse().find((m) => m.role === "assistant");
  let working;
  switch (source) {
    case "codex": working = lastLifecycle === "task_started"; break;
    case "cursor": working = cursorTail?.role === "assistant" && cursorTail.lastBlock === "tool_use"; break;
    // a prompt is running (no stopReason yet) or the sandbox is still provisioning
    case "posthog-code": working = pcPromptReq > pcPromptDone || pcSetupActive; break;
    case "pi": working = lastMsg.role === "assistant" && !!lastAsst && lastAsst.stop === "toolUse"; break;
    case "opencode": working = ocAsstOpen; break;
    case "antigravity": working = agLastStatus != null && agLastStatus !== "DONE"; break;
    case "grok-build": working = false; break; // no documented terminal signal yet — never claim "working"
    default: working = lastMsg.role === "assistant" && !!lastAsst && lastAsst.stop === "tool_use";
  }

  // PostHog Code: a cloud task whose stream died/finished mid-provision leaves a frozen session log
  // (no repo, stuck "in_progress"). Backfill ONLY those gaps from the app's main.log, by task-run id
  // (== sessionId) — the session stream stays authoritative for everything it actually recorded.
  if (source === "posthog-code") {
    const ml = posthogMainLog().get(sessionId);
    if (ml) {
      if (repo === "(unknown)" && ml.repo) repo = ml.repo;   // stream never logged the repo → use the launch line
      if (working && ml.ended) working = false;              // app stopped watching it → it isn't working
    }
  }
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
    // PostHog Code runs local or in a PostHog-owned cloud sandbox; a cloud run works while the
    // owner is away, so it's worth flagging in triage.
    ...(source === "posthog-code" ? { environment: pcEnv || (pcRepo ? "cloud" : "local") } : {}),
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
    _subagent: cursorSubagent,                         // a Cursor sub-task; loses dedup to its parent
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
  // A Cursor sub-task never represents its core session: the parent transcript always wins, whatever
  // its relative richness. Otherwise the richest (most user turns → most messages → most recent) wins.
  const richer = !p
    || (p._subagent && !t._subagent)
    || (p._subagent === t._subagent && (t.userMessages > p.userMessages
      || (t.userMessages === p.userMessages && (t.messageCount > p.messageCount
        || (t.messageCount === p.messageCount && t._sort > p._sort)))));
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
  // if it's an automated single-turn worker, and don't apply the limit.
  threads = threads.filter((t) => t.id === threadArg || t.id.startsWith(threadArg) || basename(t.file).startsWith(threadArg));
} else if (!includeAll) {
  threads = threads.filter((t) => !t.automated);
}
threads.sort((a, b) => b._sort - a._sort);
if (!threadArg) threads = threads.slice(0, limit);
threads.forEach((t) => { delete t._sort; delete t._subagent; });

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

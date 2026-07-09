#!/usr/bin/env node
// sessions-grep — Owner Operator's wrapper around the vendored `session-grep` primitive
// (vendor/, a verbatim copy of the standalone repo). The primitive owns the hard part —
// rg discovery, per-format parsing, rarity ranking, budgets, browse modes. This wrapper
// owns only what the primitive must NOT: WHERE the owner's sessions live (from oo config)
// and WHAT is off-limits (the privacy blacklist). Keeping those here — not forked into the
// primitive — is what lets an upstream release drop into vendor/ untouched.
//
// The seam is small and stable:
//   • sources     → SESSION_GREP_SOURCES_FILE (typed {type,root} roots from loadSessionSources)
//   • blacklist   → layer 1 (claude project-dir slug) as --exclude-re; layer 2 (session cwd)
//                   post-filtered on the few hit files (search) or pre-scanned (browse)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBlacklist, isBlacklisted, pathSlugs } from "../../packages/core/src/blacklist.mjs";
import { loadSessionSources } from "../../packages/core/src/session-sources.mjs";
import { firstCwdFromFile, resolveRepo } from "../../packages/core/src/session-cwd.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, "..", "..", "vendor", "session-grep", "session-grep.mjs");
const ooHome = process.env.OO_HOME ?? path.join(os.homedir(), ".owner-operator");

// ---------- parse the oo-only flags, pass everything else straight through ----------
// --limit / --max-chars are also intercepted (search mode only): layer-2 blacklist filtering
// happens AFTER the primitive applies them, so the wrapper over-fetches and re-applies the
// caller's real numbers on output — blacklisted hits must not eat the caller's budget.
const argv = process.argv.slice(2);
let targetType = "all", userWantsJson = false;
let limit = 20, maxChars = 8000, limitSet = false, maxCharsSet = false;
const passthrough = [];
// Flags whose presence means a browse/window/list mode: the primitive streams TEXT for
// these (no per-hit json to annotate), so the wrapper enforces the blacklist up front and
// lets the primitive's output through unchanged.
const BROWSE = new Set(["--overview", "--skim", "--session", "--at", "--list-roots"]);
let browse = false, listRoots = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--target-type") targetType = argv[++i];
  else if (a === "--limit") { limit = Number(argv[++i]); limitSet = true; }
  else if (a === "--max-chars") { maxChars = Number(argv[++i]); maxCharsSet = true; }
  else {
    if (a === "--json") userWantsJson = true;
    if (a === "--list-roots") listRoots = true;
    if (BROWSE.has(a)) browse = true;
    passthrough.push(a);
  }
}
if (!["all", "claude", "codex"].includes(targetType)) {
  console.error("--target-type must be all, claude, or codex");
  process.exit(1);
}
// The caller's real output knobs, re-injected verbatim in browse modes so the primitive's
// own defaults (e.g. --skim's roomier budget when --max-chars is unset) survive.
const knobArgs = [
  ...(limitSet ? ["--limit", String(limit)] : []),
  ...(maxCharsSet ? ["--max-chars", String(maxChars)] : []),
];

// ---------- WHERE to search: typed roots from oo config (fail closed) ----------
// Owner coding sessions only — but ONLY sources the vendored primitive can parse AND we can
// blacklist-resolve (claude, codex). cursor/posthog-code are in oo's config for triage but
// have no session-grep adapter, so they're dropped here rather than silently mis-parsed:
// privacy scope is bounded by what we can actually vet. Owner Operator's own sessions are
// searched by pointing the vendored primitive directly at <OO_HOME>/sessions as type `pi`.
const codingRoots = loadSessionSources(ooHome)
  .filter((r) => r.source === "claude" || r.source === "codex")
  .map((r) => ({ type: r.source, root: r.root }));
const sourcesEntries = codingRoots;
const targetTypeArgs = targetType === "all" ? [] : ["--target-type", targetType];

const sourcesFile = path.join(os.tmpdir(), `oo-sessions-grep-sources-${process.pid}.json`);
fs.writeFileSync(sourcesFile, JSON.stringify(sourcesEntries));
const cleanup = () => { try { fs.unlinkSync(sourcesFile); } catch { /* already gone */ } };

// ---------- WHAT is off-limits: the blacklist (ABSOLUTE — no flag bypasses it) ----------
const blacklist = loadBlacklist(ooHome);
// Layer 1: a claude session whose project-dir slug is blacklisted — excluded by path so
// rg never even reads it. Slug match mirrors the scan: dirName === slug || startsWith(slug-).
const slugRes = pathSlugs(blacklist).map((s) => {
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:^|/)${esc}(?:-[^/]*)?/[^/]+\\.jsonl$`;
});
// Layer 2: a session whose recorded cwd/repo sits in a blacklisted tree (catches codex and
// claude sessions whose dir name isn't the slug). Bounded-prefix read (the cwd sits in the
// first records), cached per file.
const cwdCache = new Map();
function fileBlacklisted(file) {
  if (cwdCache.has(file)) return cwdCache.get(file);
  let verdict = false;
  try {
    const cwd = firstCwdFromFile(file);
    verdict = !!cwd && isBlacklisted(blacklist, { cwd, repo: resolveRepo(cwd) });
  } catch { /* unreadable → don't surface it anyway */ verdict = true; }
  cwdCache.set(file, verdict);
  return verdict;
}

const excludeRes = [...slugRes];
// Browse/window modes stream text and can't be post-filtered per hit, so enforce layer 2
// there by pre-scanning EVERY root and excluding blacklisted files by path. The slug layer
// (above) still short-circuits most claude hits cheaply, but a claude session whose dir
// name isn't the blacklisted slug (cwd blacklisted post-parse) is only caught by this scan
// — so it must include claude too. Browse is itself a full scan, so the header reads are
// proportionate; search mode skips this and post-filters just the hit files instead.
// --list-roots prints no session content, so it skips the scan entirely.
if (browse && !listRoots) {
  for (const { root } of sourcesEntries) {
    if (!fs.existsSync(root)) continue;
    for (const f of walk(root)) {
      if (fileBlacklisted(f)) excludeRes.push(`^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    }
  }
}

const excludeArgs = excludeRes.flatMap((r) => ["--exclude-re", r]);
const env = { ...process.env, SESSION_GREP_SOURCES_FILE: sourcesFile };

// ---------- browse/window/list: stream the primitive's output, blacklist already applied ----------
if (browse) {
  const r = spawnSync(process.execPath, [TOOL, ...passthrough, ...knobArgs, ...targetTypeArgs, ...excludeArgs], { stdio: "inherit", env });
  cleanup();
  process.exit(r.status ?? 0);
}

// ---------- search: run the primitive in JSON, then blacklist-filter ----------
// Force --json so we can drop blacklisted hits (layer 2) before output.
// Over-fetch limit and budget (the primitive computes every match regardless — the scaled
// numbers only widen its output window), then trim back to the caller's real numbers after
// filtering so blacklisted hits don't shortchange --limit.
if (!Number.isFinite(limit) || limit < 1) { console.error("--limit must be >= 1"); cleanup(); process.exit(1); }
if (!Number.isFinite(maxChars) || maxChars < 500) { console.error("--max-chars must be >= 500"); cleanup(); process.exit(1); }
const FETCH_FACTOR = 3;
// The internal budget must CARRY the over-fetched entries, not just scale the caller's
// number — a small --max-chars would otherwise starve the backfill before filtering.
// ~1200 chars bounds a slim JSON entry at default context; the caller's budget is
// re-applied on output either way, so generous here costs nothing downstream.
const internalMaxChars = Math.max(maxChars * FETCH_FACTOR, limit * FETCH_FACTOR * 1200);
const jsonArgs = [
  ...passthrough.filter((a) => a !== "--json"), "--json",
  "--limit", String(limit * FETCH_FACTOR),
  "--max-chars", String(internalMaxChars),
];
const r = spawnSync(process.execPath, [TOOL, ...jsonArgs, ...targetTypeArgs, ...excludeArgs], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
if (r.stderr) process.stderr.write(r.stderr);
if (r.status !== 0 || !r.stdout.trim()) { cleanup(); process.exit(r.status ?? 1); }
cleanup();

let out;
try { out = JSON.parse(r.stdout); } catch { process.stdout.write(r.stdout); process.exit(0); }

const kept = [];
let blacklistedDropped = 0;
for (const m of out.matches ?? []) {
  if (fileBlacklisted(m.path)) { blacklistedDropped++; continue; } // layer 2 (search): only hit files are read
  kept.push(m);
}
const trimmed = kept.slice(0, limit);
// Even the over-fetch couldn't backfill what the blacklist dropped — say so rather than
// letting a short result read as "that's all there is".
const shortfall = blacklistedDropped > 0 && trimmed.length < limit && out.totalMatches > (out.matches?.length ?? 0)
  ? `fewer than --limit shown: ${blacklistedDropped} hit(s) fell in blacklisted sessions — raise --limit or --max-chars to search past them`
  : null;

// Re-apply the caller's real output budget (the internal call ran with it scaled). Mirrors
// the primitive: hits emitted in rank order until the budget runs out, never dumped.
function emitWithinBudget(renderLen) {
  const emitted = [];
  let size = 300; // header allowance, mirrors the primitive
  for (const m of trimmed) {
    const len = renderLen(m);
    if (size + len > maxChars && emitted.length) break;
    size += len;
    emitted.push(m);
  }
  return emitted;
}
const budgetNote = (n) => `... ${n} more matching messages omitted by the ${maxChars}-char output budget — narrow with --role/--since, or raise --max-chars`;

if (userWantsJson) {
  const emitted = emitWithinBudget((m) => JSON.stringify(m).length);
  const omitted = trimmed.length - emitted.length;
  out.matches = emitted;
  out.shown = emitted.length;
  delete out.omittedByBudget; // recomputed against the caller's budget, not the scaled one
  delete out.note;
  if (blacklistedDropped) out.blacklistedDropped = blacklistedDropped;
  if (shortfall) out.shortfall = shortfall;
  if (omitted) { out.omittedByBudget = omitted; out.note = budgetNote(omitted); }
  process.stdout.write(JSON.stringify(out) + "\n");
} else {
  // Mirror the primitive's text layout after privacy filtering.
  const renderHit = (m) => [
    `${m.source} id=${m.id} idx=${m.index} ts=${m.timestamp ?? ""}${m.matchedWords ? ` matched=[${m.matchedWords.join(",")}] score=${m.score}` : ""}`,
    `path=${m.path}`,
    ...(m.before ?? []).map((b) => `  before ${b.role}: ${b.text}`),
    `  MATCH ${m.match.role}: ${m.match.text}`,
    ...(m.after ?? []).map((a) => `  after  ${a.role}: ${a.text}`),
  ];
  const emitted = emitWithinBudget((m) => renderHit(m).reduce((t, l) => t + l.length + 1, 6));
  const omitted = trimmed.length - emitted.length;
  console.log(`query=${JSON.stringify(out.query ?? "")}${out.regex ? " regex=true" : ""}${out.any ? " any=true" : ""} raw_files_with_hits=${out.rawFilesWithHits} total_message_matches=${out.totalMatches} shown=${emitted.length}${targetType !== "all" ? ` target_type=${targetType}` : ""}${blacklistedDropped ? ` blacklisted_dropped=${blacklistedDropped}` : ""}`);
  if (out.wordHits) console.log(`word_hits: ${Object.entries(out.wordHits).map(([w, c]) => `${w}=${c}`).join(" ")} (of ${out.messagesScanned} messages in matched files; high-count words are low-signal — prefer the rare ones)`);
  if (out.hint) console.log(`hint: ${out.hint}`);
  emitted.forEach((m, idx) => {
    const [head, ...rest] = renderHit(m);
    console.log(`\n[${idx + 1}] ${head}`);
    for (const l of rest) console.log(l);
  });
  if (shortfall) console.log(`\nnote: ${shortfall}`);
  if (omitted) console.log(`\n${budgetNote(omitted)}`);
}

// ---------- helpers ----------
function walk(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

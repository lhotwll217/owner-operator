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
//   • self        → oo's own pi-format threads, routed as `type: pi`, labeled from provenance
//
// oo-only surface kept identical to before: --source claude|codex|self|all (self excluded
// from `all`), --surface to narrow self by oo surface, provenance/repo labels on self hits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBlacklist, isBlacklisted, pathSlugs } from "../../../packages/core/src/blacklist.mjs";
import { loadSessionSources } from "../../../packages/core/src/session-sources.mjs";
import { firstCwd, resolveRepo } from "../../../packages/core/src/session-cwd.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, "vendor", "session-grep.mjs");
const ooHome = process.env.OO_HOME ?? path.join(os.homedir(), ".owner-operator");
const selfRoot = path.join(ooHome, "sessions");

// ---------- parse the oo-only flags, pass everything else straight through ----------
const argv = process.argv.slice(2);
let source = "all", surface = null, userWantsJson = false;
const passthrough = [];
// Flags whose presence means a browse/window/list mode: the primitive streams TEXT for
// these (no per-hit json to annotate), so the wrapper enforces the blacklist up front and
// lets the primitive's output through unchanged.
const BROWSE = new Set(["--overview", "--skim", "--session", "--at", "--list-roots"]);
let browse = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--source") source = argv[++i];
  else if (a === "--surface") surface = argv[++i];
  else {
    if (a === "--json") userWantsJson = true;
    if (BROWSE.has(a)) browse = true;
    passthrough.push(a);
  }
}
if (!["all", "claude", "codex", "self"].includes(source)) {
  console.error("--source must be all, claude, codex, or self");
  process.exit(1);
}

// ---------- WHERE to search: typed roots from oo config (fail closed) ----------
// `self` = oo's own threads (pi format) under <OO_HOME>/sessions, deliberately excluded
// from `all`. Otherwise the owner's coding sessions — but ONLY sources the vendored
// primitive can parse AND we can blacklist-resolve (claude, codex). cursor/posthog-code are
// in oo's config for triage but have no session-grep adapter, so they're dropped here
// rather than silently mis-parsed: privacy scope is bounded by what we can actually vet.
const codingRoots = loadSessionSources(ooHome)
  .filter((r) => r.source === "claude" || r.source === "codex")
  .map((r) => ({ type: r.source, root: r.root }));
const sourcesEntries = source === "self" ? [{ type: "pi", root: selfRoot }] : codingRoots;
// The primitive's own --source filters among the loaded roots; for `self` we hand it only
// the pi root, so `all` there means "every self surface".
const toolSource = source === "self" ? "all" : source;

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
// claude sessions whose dir name isn't the slug). Read a file's cwd once; cache it.
const cwdCache = new Map();
function fileBlacklisted(file) {
  if (cwdCache.has(file)) return cwdCache.get(file);
  let verdict = false;
  try {
    const cwd = firstCwd(fs.readFileSync(file, "utf8"));
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
if (browse) {
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
  const r = spawnSync(process.execPath, [TOOL, ...passthrough, "--source", toolSource, ...excludeArgs], { stdio: "inherit", env });
  cleanup();
  process.exit(r.status ?? 0);
}

// ---------- search: run the primitive in JSON, then blacklist-filter + self-annotate ----------
// Force --json so we can drop blacklisted hits (layer 2) and label self hits before output.
const jsonArgs = passthrough.includes("--json") ? passthrough : [...passthrough, "--json"];
const r = spawnSync(process.execPath, [TOOL, ...jsonArgs, "--source", toolSource, ...excludeArgs], { encoding: "utf8", env });
if (r.stderr) process.stderr.write(r.stderr);
if (r.status !== 0 || !r.stdout.trim()) { cleanup(); process.exit(r.status ?? 1); }
cleanup();

let out;
try { out = JSON.parse(r.stdout); } catch { process.stdout.write(r.stdout); process.exit(0); }

const kept = [];
for (const m of out.matches ?? []) {
  if (fileBlacklisted(m.path)) continue; // layer 2 (search): only hit files are read
  if (m.source === "pi") {
    // oo's own thread: label from the latest oo-provenance stamp; --surface narrows here.
    const prov = piProvenance(m.path);
    if (surface && prov?.surface !== surface) continue;
    kept.push({ ...m, source: "self", surface: prov?.surface, repo: prov?.callerRepo, provenance: prov ?? undefined });
  } else {
    if (surface) continue; // --surface only matches labeled self threads
    kept.push(m);
  }
}

out.matches = kept;
out.shown = kept.length;

if (userWantsJson) {
  process.stdout.write(JSON.stringify(out) + "\n");
} else {
  // Mirror the primitive's text layout, adding oo's self labels (surface/repo).
  console.log(`query=${JSON.stringify(out.query ?? "")}${out.any ? " any=true" : ""} shown=${kept.length}${source !== "all" ? ` source=${source}` : ""}`);
  kept.forEach((m, idx) => {
    const label = m.surface ? ` surface=${m.surface} repo=${m.repo ?? ""}` : "";
    console.log(`\n[${idx + 1}] ${m.source}${label} id=${m.id} idx=${m.index} ts=${m.timestamp ?? ""}`);
    console.log(`path=${m.path}`);
    for (const b of m.before ?? []) console.log(`  before ${b.role}: ${b.text}`);
    console.log(`  MATCH ${m.match.role}: ${m.match.text}`);
    for (const a of m.after ?? []) console.log(`  after  ${a.role}: ${a.text}`);
  });
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

// Latest oo-provenance stamp in an oo thread: {type:"custom", customType:"oo-provenance",
// data:{surface, origin, callerCwd, callerRepo, fromSession?, ppid}}. Every invocation
// appends one, so the last stamp is the most recent caller.
function piProvenance(file) {
  let latest = null;
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "custom" && obj.customType === "oo-provenance" && obj.data) latest = obj.data;
  }
  return latest;
}

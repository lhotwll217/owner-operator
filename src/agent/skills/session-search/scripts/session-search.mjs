#!/usr/bin/env node
// Owner Operator policy wrapper around the vendored session-grep primitive.
// This helper is invoked by the session-search skill through Pi's native bash tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBlacklist, isBlacklisted, pathSlugs } from "../../../../../packages/core/src/blacklist.mjs";
import { loadSessionSources } from "../../../../../packages/core/src/session-sources.mjs";
import { firstCwdFromFile, resolveRepo } from "../../../../../packages/core/src/session-cwd.mjs";

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const primitive = path.join(skillDir, "vendor", "session-grep", "session-grep.mjs");
const ooHome = process.env.OO_HOME ?? path.join(os.homedir(), ".owner-operator");
const callerSessionId = process.env.OO_CALLER_SESSION_ID?.trim() || null;
const input = process.argv.slice(2);

let ownerOperator = false;
let candidates = false;
let targetType = "all";
let json = false;
let limit = 20;
let maxChars = 8_000;
let targetRoot = null;
let hasQuery = false;
let hasSession = false;
let hasSkim = false;
let hasAt = false;
const passthrough = [];
for (let index = 0; index < input.length; index += 1) {
  const arg = input[index];
  if (arg === "--owner-operator") ownerOperator = true;
  else if (arg === "--target-type" || arg === "--source") targetType = takeValue(arg, ++index);
  else if (arg === "--target-root") targetRoot = takeValue(arg, ++index);
  else if (arg === "--limit") limit = Number(takeValue(arg, ++index));
  else if (arg === "--max-chars") maxChars = Number(takeValue(arg, ++index));
  else if (["--query", "--skim", "--session", "--at", "--since", "--sort", "--before", "--after"].includes(arg)) {
    if (arg === "--query") hasQuery = true;
    if (arg === "--session") hasSession = true;
    if (arg === "--skim") hasSkim = true;
    if (arg === "--at") hasAt = true;
    passthrough.push(arg, takeValue(arg, ++index, { allowLeadingDashes: arg === "--query" }));
  } else if (["--any", "--candidates", "--regex", "--json", "--case-sensitive"].includes(arg)) {
    if (arg === "--candidates") candidates = true;
    if (arg === "--json") json = true;
    passthrough.push(arg);
  }
  else {
    fail(`unsupported session-search argument: ${arg}`);
  }
}

if (!["all", "claude", "codex"].includes(targetType)) fail("--target-type must be all, claude, or codex");
if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");
if (!Number.isInteger(maxChars) || maxChars < 500) fail("--max-chars must be an integer of at least 500");
const sources = ownerOperator
  ? [{ type: "pi", root: path.join(ooHome, "sessions") }]
  : loadSessionSources(ooHome)
      .filter((source) => source.source === "claude" || source.source === "codex")
      .map((source) => ({ type: source.source, root: source.root }));
if (targetRoot) {
  const wanted = path.resolve(targetRoot);
  if (!sources.some((source) => path.resolve(source.root) === wanted)) {
    fail("--target-root must name a configured session source");
  }
  passthrough.push("--target-root", wanted);
}
const sourceFile = path.join(os.tmpdir(), `oo-session-search-${process.pid}.json`);
fs.writeFileSync(sourceFile, JSON.stringify(sources));

const blacklist = loadBlacklist(ooHome);
const excludePatterns = pathSlugs(blacklist).map((slug) => {
  const escaped = escapeRegex(slug);
  return `(?:^|/)${escaped}(?:-[^/]*)?/[^/]+\\.jsonl$`;
});
const cwdCache = new Map();
const fileBlacklisted = (file) => {
  if (cwdCache.has(file)) return cwdCache.get(file);
  let blocked = true;
  try {
    const cwd = firstCwdFromFile(file);
    blocked = !!cwd && isBlacklisted(blacklist, { cwd, repo: resolveRepo(cwd) });
  } catch {
    blocked = true;
  }
  cwdCache.set(file, blocked);
  return blocked;
};

const browse = hasSkim || (hasSession && hasAt);
const scopedQuery = hasQuery && hasSession && !hasAt;
const directRead = browse || scopedQuery;
if (candidates && browse) fail("--candidates is only valid with --query");
// Discovery should not retrieve the prompt currently asking the question. Direct reads
// preserve an explicit known-ID request regardless of which session supplied that ID.
if (directRead) {
  for (const { root } of sources) {
    for (const file of walk(root)) {
      if (fileBlacklisted(file)) excludePatterns.push(`^${escapeRegex(file)}$`);
    }
  }
}

const sourceArgs = ["--sources-file", sourceFile];
const typeArgs = ownerOperator || targetType === "all" ? [] : ["--target-type", targetType];
const excludeArgs = excludePatterns.flatMap((pattern) => ["--exclude-re", pattern]);
const callerExcludeArgs = !directRead && callerSessionId ? ["--exclude-session", callerSessionId] : [];

try {
  if (browse) {
    const result = runPrimitive([
      ...passthrough,
      "--limit", String(limit),
      "--max-chars", String(maxChars),
      ...sourceArgs,
      ...typeArgs,
      ...excludeArgs,
    ]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  } else {
    const fetchLimit = limit * (candidates ? 5 : 3);
    const result = runPrimitive([
      ...passthrough.filter((arg) => arg !== "--json"),
      "--json",
      "--limit", String(fetchLimit),
      // Let the primitive's aperture remain authoritative. The wrapper may return fewer
      // rows after its cwd blacklist, but must not refill them by silently tripling context.
      "--max-chars", String(maxChars),
      ...sourceArgs,
      ...typeArgs,
      ...callerExcludeArgs,
      ...excludeArgs,
    ]);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    } else {
      const output = JSON.parse(result.stdout);
      const allowed = [];
      let blacklistedDropped = 0;
      const entries = candidates ? output.candidates ?? [] : output.matches ?? [];
      for (const entry of entries) {
        if (fileBlacklisted(entry.path)) {
          blacklistedDropped += 1;
          continue;
        }
        if (candidates) {
          let repo = null;
          try { repo = resolveRepo(firstCwdFromFile(entry.path)); } catch { /* best effort label */ }
          allowed.push({ ...entry, repo });
        } else {
          allowed.push(entry);
        }
      }
      if (candidates) {
        output.candidates = allowed.slice(0, limit);
        output.shown = output.candidates.length;
        // The primitive's total is exact before the wrapper's cwd-based privacy filter.
        // If that second layer drops a returned row, an exact post-policy total would
        // require eagerly parsing the entire corpus. Expose an honest lower bound instead.
        if (blacklistedDropped) {
          output.totalCandidateSessionsBeforePolicy = output.totalCandidateSessions;
          output.candidateSessionsAfterPolicyAtLeast = allowed.length;
          delete output.totalCandidateSessions;
        }
      } else {
        output.matches = allowed.slice(0, limit);
        output.shown = output.matches.length;
      }
      output.callerSessionExclusion = callerExcludeArgs.length
        ? { applied: true, sessionId: callerSessionId }
        : directRead
          ? { applied: false, reason: "explicit stable-session scope; caller exclusion is discovery-only" }
          : { applied: false, reason: "caller session id unavailable; agents can pass oo --from-session ID" };
      if (blacklistedDropped) output.blacklistedDropped = blacklistedDropped;

      if (json) process.stdout.write(`${JSON.stringify(output)}\n`);
      else renderText(output, { targetType, blacklistedDropped });
    }
  }
} finally {
  try { fs.unlinkSync(sourceFile); } catch { /* best effort */ }
}

function runPrimitive(args) {
  return spawnSync(process.execPath, [primitive, ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function renderText(output, context) {
  const callerExclusion = output.callerSessionExclusion?.applied
    ? `applied:${output.callerSessionExclusion.sessionId}`
    : output.callerSessionExclusion?.reason?.startsWith("explicit stable-session scope")
      ? "not-needed:explicit-session-scope"
      : "unavailable";
  const candidateCount = !output.candidates
    ? ""
    : output.totalCandidateSessions != null
      ? ` candidate_sessions=${output.totalCandidateSessions}`
      : ` candidate_sessions_at_least=${output.candidateSessionsAfterPolicyAtLeast ?? output.candidates.length}` +
        ` pre_policy_candidate_sessions=${output.totalCandidateSessionsBeforePolicy ?? "unknown"}`;
  console.log(
    `query=${JSON.stringify(output.query ?? "")} total_message_matches=${output.totalMatches ?? 0} ` +
    `shown=${output.shown ?? 0}${output.session ? ` session=${output.session}` : ""}${output.any ? " any=true" : ""}` +
    candidateCount +
    `${context.targetType !== "all" ? ` target_type=${context.targetType}` : ""}` +
    `${context.blacklistedDropped ? ` blacklisted_dropped=${context.blacklistedDropped}` : ""} ` +
    `caller_session_exclusion=${callerExclusion}`,
  );
  if (output.wordHits) {
    console.log(`word_hits: ${Object.entries(output.wordHits).map(([word, hits]) => `${word}=${hits}`).join(" ")} (high-count words are low-signal; prefer the rare ones)`);
  }
  if (output.note) console.log(`note: ${output.note}`);
  if (output.hint) console.log(`hint: ${output.hint}`);
  for (const [index, candidate] of (output.candidates ?? []).entries()) {
    const rank = candidate.matchedWords?.length
      ? ` matched=[${candidate.matchedWords.join(",")}] best_score=${candidate.score}`
      : "";
    console.log(
      `\n[${index + 1}] ${candidate.source} id=${candidate.id} repo=${candidate.repo ?? "unknown"} ` +
      `best_idx=${candidate.index} ts=${candidate.timestamp ?? ""} hits=${candidate.hitCount}${rank}`,
    );
    console.log(`  BEST ${candidate.match.role}: ${candidate.match.text}`);
  }
  for (const [index, match] of (output.matches ?? []).entries()) {
    const rank = match.matchedWords ? ` matched=[${match.matchedWords.join(",")}] score=${match.score}` : "";
    console.log(`\n[${index + 1}] ${match.source} id=${match.id} idx=${match.index} ts=${match.timestamp ?? ""}${rank}`);
    for (const before of match.before ?? []) console.log(`  before ${before.role}: ${before.text}`);
    console.log(`  MATCH ${match.match.role}: ${match.match.text}`);
    for (const after of match.after ?? []) console.log(`  after  ${after.role}: ${after.text}`);
  }
  if ((output.matches ?? []).some((match) => String(match.match?.text ?? "").endsWith("..."))) {
    console.log("\nhint: a match preview was truncated; use --session ID --at IDX for fuller context around that hit");
  }
  if (output.candidates?.length) {
    console.log("\nhint: candidates group all ranked message hits by stable session id before limits; use --skim ID or --session ID --at BEST_IDX to inspect one");
  }
}

function walk(root) {
  const files = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile() && target.endsWith(".jsonl")) files.push(target);
  }
  return files;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function takeValue(flag, index, { allowLeadingDashes = false } = {}) {
  const value = input[index];
  if (!value || (!allowLeadingDashes && value.startsWith("--"))) fail(`${flag} needs a value`);
  return value;
}

#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SESSION_SEARCH_PASSTHROUGH_VALUE_FLAGS } from "./flags.mjs";
import { loadBlacklist, isBlacklisted, pathSlugs } from "../../packages/core/src/blacklist.mjs";
import {
  loadSessionSources,
  ownerOperatorTranscriptStore,
} from "../../packages/core/src/session-sources.mjs";
import {
  firstCwdFromFile,
  latestOwnerOperatorProvenance,
  resolveRepo,
} from "../../packages/core/src/session-cwd.mjs";

const primitive = fileURLToPath(new URL("./vendor/session-grep/session-grep.mjs", import.meta.url));
const ooHome = process.env.OO_HOME ?? path.join(os.homedir(), ".owner-operator");
const callerSessionId = process.env.OO_CALLER_SESSION_ID?.trim() || null;
const currentOoSessionId = process.env.OO_CURRENT_SESSION_ID?.trim() || null;
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
  if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  }
  if (arg === "--owner-operator") ownerOperator = true;
  else if (arg === "--target-type" || arg === "--source") targetType = takeValue(arg, ++index);
  else if (arg === "--target-root") targetRoot = takeValue(arg, ++index);
  else if (arg === "--limit") limit = Number(takeValue(arg, ++index));
  else if (arg === "--max-chars") maxChars = Number(takeValue(arg, ++index));
  else if (SESSION_SEARCH_PASSTHROUGH_VALUE_FLAGS.includes(arg)) {
    if (arg === "--query") hasQuery = true;
    if (arg === "--session") hasSession = true;
    if (arg === "--skim") hasSkim = true;
    if (arg === "--at") hasAt = true;
    passthrough.push(arg, takeValue(arg, ++index, { allowLeadingDashes: arg === "--query" }));
  } else if (["--any", "--candidates", "--regex", "--json", "--case-sensitive", "--include-tools", "--include-skill-bodies"].includes(arg)) {
    if (arg === "--candidates") candidates = true;
    if (arg === "--json") json = true;
    passthrough.push(arg);
  }
  else {
    fail(`unsupported session-search argument: ${arg}`);
  }
}

if (!["all", "claude", "codex", "pi"].includes(targetType)) fail("--target-type must be all, claude, codex, or pi");
if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");
if (!Number.isInteger(maxChars) || maxChars < 500) fail("--max-chars must be an integer of at least 500");
const codingSources = loadSessionSources(ooHome)
  .filter((source) => ["claude", "codex", "pi"].includes(source.source))
  .map((source) => ({ type: source.source, root: source.root, namespace: "coding" }));
const productStore = ownerOperatorTranscriptStore(ooHome);
const productSource = {
  type: productStore.format,
  root: productStore.root,
  namespace: productStore.namespace,
  app: productStore.app,
};
const sources = ownerOperator
  ? [productSource]
  : targetType === "all"
    ? [...codingSources, productSource]
    : codingSources;
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
    const cwd = searchCwdFromFile(file);
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
const stemsByStableId = new Map();
if (directRead) {
  for (const { root } of sources) {
    for (const file of walk(root)) {
      if (fileBlacklisted(file)) excludePatterns.push(`^${escapeRegex(file)}$`);
      const stem = path.basename(file, ".jsonl");
      const stable = stableSessionId(stem);
      if (stable !== stem) stemsByStableId.set(stable, stem);
    }
  }
}

// Pi writes `<timestamp>_<stable-id>.jsonl` (pi-coding-agent `SessionManager`), so the
// primitive's filename-derived id carries that prefix while Owner Operator's database,
// widget, and deep links carry the stable id alone. Translate on the way in and back on
// the way out, so one id works across the database and every search mode.
let rewrittenStem = null;
if (directRead) {
  const flag = hasSkim ? "--skim" : "--session";
  const at = passthrough.indexOf(flag);
  const requested = passthrough[at + 1];
  const stem = stemsByStableId.get(requested);
  if (stem) {
    passthrough[at + 1] = stem;
    rewrittenStem = { stem, stableId: requested };
  }
}

const discoverySessionIds = [...new Set([currentOoSessionId, callerSessionId].filter(Boolean))];
const sessionExcludeArgs = directRead
  ? []
  : discoverySessionIds.flatMap((sessionId) => ["--exclude-session", sessionId]);
// Pi names saved transcripts `<timestamp>_<stable-id>.jsonl`, while the vendored
// primitive's canonical session exclusion falls back to the full filename stem for Pi.
// Its path-exclusion seam lets the wrapper exclude the same live stable IDs without
// parsing transcript headers or changing explicit known-ID reads.
if (!directRead) {
  excludePatterns.push(...discoverySessionIds.map((sessionId) =>
    `(?:^|[/_])${escapeRegex(sessionId)}\\.jsonl$`));
}
const sourceArgs = ["--sources-file", sourceFile];
const typeArgs = ownerOperator || targetType === "all" ? [] : ["--target-type", targetType];
const excludeArgs = excludePatterns.flatMap((pattern) => ["--exclude-re", pattern]);

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
    process.stdout.write(rewrittenStem
      ? result.stdout.replaceAll(`id=${rewrittenStem.stem}`, `id=${rewrittenStem.stableId}`)
      : result.stdout);
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
      ...sessionExcludeArgs,
      ...excludeArgs,
    ]);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    } else {
      const output = JSON.parse(result.stdout);
      if (output.session) output.session = stableSessionId(output.session);
      const allowed = [];
      let blacklistedDropped = 0;
      const entries = candidates ? output.candidates ?? [] : output.matches ?? [];
      for (const entry of entries) {
        const file = transcriptFileFor(entry);
        if (!file || fileBlacklisted(file)) {
          blacklistedDropped += 1;
          continue;
        }
        const identified = { ...entry, id: stableSessionId(entry.id), ...sourceIdentity(file) };
        if (candidates) {
          let repo = null;
          try { repo = resolveRepo(searchCwdFromFile(file)); } catch { /* best effort label */ }
          allowed.push({ ...identified, repo });
        } else {
          allowed.push(identified);
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
      output.discoverySessionExclusions = sessionExcludeArgs.length
        ? { applied: true, sessionIds: discoverySessionIds }
        : directRead
          ? { applied: false, reason: "explicit stable-session scope; session exclusion is discovery-only" }
          : { applied: false, reason: "current OO and external caller session ids unavailable" };
      if (blacklistedDropped) output.blacklistedDropped = blacklistedDropped;

      process.stdout.write(withinBudget(output, (fitted) => json
        ? `${JSON.stringify(fitted)}\n`
        : renderText(fitted, { targetType, blacklistedDropped })));
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

/** The primitive budgets its own JSON, but the wrapper then adds namespace, app, repo, and
 * exclusion fields and renders its own text. Hold the final output to --max-chars the way the
 * primitive does — evidence outranks metadata, and a hit outranks its context: drop trailing
 * entries (counted as omitted), then shrink the last hit (context, then path, then the match text
 * around its matching span), then trim metadata; the hit is dropped only if nothing else fits. */
function withinBudget(output, render) {
  const key = candidates ? "candidates" : "matches";
  const over = () => Buffer.byteLength(rendered) - maxChars;
  let rendered = render(output);
  const refresh = () => { rendered = render(output); };
  const omitted = (count) => {
    output.omittedByBudget = (output.omittedByBudget ?? 0) + count;
    output.note = `... ${output.omittedByBudget} more matching ${candidates ? "sessions" : "messages"} omitted by the ${maxChars}-byte output budget — narrow the search or raise --max-chars`;
  };
  while (over() > 0 && output[key].length > 1) {
    output[key].pop();
    output.shown = output[key].length;
    omitted(1);
    refresh();
  }
  const [hit] = output[key];
  if (hit && over() > 0 && (hit.before?.length || hit.after?.length)) {
    hit.before = [];
    hit.after = [];
    refresh();
  }
  if (hit && over() > 0 && typeof hit.path === "string") {
    // The id names the session; the path's tail (its file) is the part worth keeping.
    hit.path = keepTail(hit.path, Buffer.byteLength(hit.path) - over());
    refresh();
  }
  if (hit?.match && over() > 0) {
    hit.match.text = keepSpan(String(hit.match.text ?? ""), queryTerms(output), Buffer.byteLength(String(hit.match.text ?? "")) - over());
    refresh();
  }
  // Metadata goes before the last piece of evidence.
  const trims = [
    () => { delete output.wordHits; delete output.messagesScanned; },
    () => { delete output.hint; },
    () => { if (output.note) output.note = `${output.omittedByBudget ?? 0} omitted by the output budget`; },
    () => {
      const exclusions = output.discoverySessionExclusions;
      if (exclusions?.sessionIds?.length) {
        exclusions.sessionIdsOmitted = exclusions.sessionIds.length;
        exclusions.sessionIds = [];
      }
    },
    () => { if (typeof output.query === "string") output.query = keepTail(output.query, Math.max(8, Buffer.byteLength(output.query) - over())); },
  ];
  for (const trim of trims) {
    if (over() <= 0) break;
    trim();
    refresh();
  }
  if (over() > 0 && output[key].length) {
    output[key] = [];
    output.shown = 0;
    omitted(1);
    refresh();
    for (const trim of trims) {
      if (over() <= 0) break;
      trim();
      refresh();
    }
  }
  return rendered;
}

function queryTerms(output) {
  const query = String(output.query ?? "");
  return (output.any ? query.split(/[\s|]+/) : [query]).map((term) => term.trim()).filter(Boolean);
}

/** Keep at most `maxBytes` of `value`, from its end. */
function keepTail(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return `...${bytes.subarray(bytes.length - Math.max(0, maxBytes - 3)).toString().replace(/^\uFFFD/, "")}`;
}

/** Keep at most `maxBytes` of `text`, centred on the first query term it contains. */
function keepSpan(text, terms, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const lower = text.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const budget = Math.max(0, maxBytes - 6);
  const center = Buffer.byteLength(text.slice(0, at));
  const start = Math.max(0, Math.min(center - Math.floor(budget / 3), bytes.length - budget));
  const kept = bytes.subarray(start, start + budget).toString().replace(/^\uFFFD|\uFFFD$/g, "");
  return `${start > 0 ? "..." : ""}${kept}${start + budget < bytes.length ? "..." : ""}`;
}

function renderText(output, context) {
  const lines = [];
  const say = (line) => lines.push(line);
  const sessionExclusions = output.discoverySessionExclusions?.applied
    ? output.discoverySessionExclusions.sessionIdsOmitted
      ? `applied:${output.discoverySessionExclusions.sessionIdsOmitted}-ids-omitted-by-budget`
      : `applied:${output.discoverySessionExclusions.sessionIds.join(",")}`
    : output.discoverySessionExclusions?.reason?.startsWith("explicit stable-session scope")
      ? "not-needed:explicit-session-scope"
      : "unavailable";
  const candidateCount = !output.candidates
    ? ""
    : output.totalCandidateSessions != null
      ? ` candidate_sessions=${output.totalCandidateSessions}`
      : ` candidate_sessions_at_least=${output.candidateSessionsAfterPolicyAtLeast ?? output.candidates.length}` +
        ` pre_policy_candidate_sessions=${output.totalCandidateSessionsBeforePolicy ?? "unknown"}`;
  say(
    `query=${JSON.stringify(output.query ?? "")} total_message_matches=${output.totalMatches ?? 0} ` +
    `files_with_matches=${output.filesWithMatches ?? 0} shown=${output.shown ?? 0}` +
    `${output.session ? ` session=${output.session}` : ""}${output.any ? " any=true" : ""}` +
    `${output.literalMultiword ? " literal_multiword=true (retry with --any; literal phrases rarely occur verbatim)" : ""}` +
    `${output.excluded?.tools ? ` tools_excluded=${output.excluded.tools} (add --include-tools)` : ""}` +
    `${output.excluded?.skillBodies ? ` skill_excluded=${output.excluded.skillBodies} (add --include-skill-bodies)` : ""}` +
    candidateCount +
    `${context.targetType !== "all" ? ` target_type=${context.targetType}` : ""}` +
    `${context.blacklistedDropped ? ` blacklisted_dropped=${context.blacklistedDropped}` : ""} ` +
    `discovery_session_exclusions=${sessionExclusions}`,
  );
  if (output.wordHits) {
    say(`word_hits: ${Object.entries(output.wordHits).map(([word, hits]) => `${word}=${hits}`).join(" ")}` +
      `${output.messagesScanned != null ? ` (of ${output.messagesScanned} messages searched after filters)` : ""}` +
      " (high-count words are low-signal; prefer the rare ones)");
  }
  if (output.note) say(`note: ${output.note}`);
  if (output.hint) say(`hint: ${output.hint}`);
  for (const [index, candidate] of (output.candidates ?? []).entries()) {
    const rank = candidate.matchedWords?.length
      ? ` matched=[${candidate.matchedWords.join(",")}] best_score=${candidate.score}`
      : "";
    const forks = candidate.forkCopies ? ` +${candidate.forkCopies} forked copies` : "";
    say(
      `\n[${index + 1}] namespace=${candidate.namespace} source=${candidate.source} id=${candidate.id} repo=${candidate.repo ?? "unknown"} ` +
      `best_idx=${candidate.index} ts=${candidate.timestamp ?? ""} hits=${candidate.hitCount}${rank}${forks}`,
    );
    say(`  BEST ${candidate.match.role}: ${candidate.match.text}`);
  }
  for (const [index, match] of (output.matches ?? []).entries()) {
    const rank = match.matchedWords ? ` matched=[${match.matchedWords.join(",")}] score=${match.score}` : "";
    const forks = match.forkCopies ? ` +${match.forkCopies} forked copies` : "";
    say(`\n[${index + 1}] namespace=${match.namespace} source=${match.source} id=${match.id} idx=${match.index} ts=${match.timestamp ?? ""}${rank}${forks}`);
    for (const before of match.before ?? []) say(`  before ${before.role}: ${before.text}`);
    say(`  MATCH ${match.match.role}: ${match.match.text}`);
    for (const after of match.after ?? []) say(`  after  ${after.role}: ${after.text}`);
  }
  if ((output.matches ?? []).some((match) => String(match.match?.text ?? "").endsWith("..."))) {
    say("\nhint: a match preview was truncated; use --session ID --at IDX for fuller context around that hit");
  }
  if (output.candidates?.length) {
    say("\nhint: candidates group all ranked message hits by stable session id before limits; use --skim ID or --session ID --at BEST_IDX to inspect one");
  }
  return `${lines.join("\n")}\n`;
}

/** The transcript file behind a primitive hit. Under a tight --max-chars the primitive shortens a
 * hit's `path` for display, so a path that is not a file is found again by its session id within
 * the configured sources. Null when it cannot be found; callers then drop the hit (fail closed). */
function transcriptFileFor(entry) {
  if (typeof entry.path === "string" && fs.existsSync(entry.path)) return entry.path;
  transcriptFileFor.index ??= new Map(sources.flatMap(({ root }) => walk(root)).map((file) => [path.basename(file, ".jsonl"), file]));
  return transcriptFileFor.index.get(entry.id) ?? null;
}

function sourceIdentity(file) {
  const resolvedFile = path.resolve(file);
  let best = null;
  for (const source of sources) {
    const root = path.resolve(source.root);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if ((resolvedFile === root || resolvedFile.startsWith(prefix)) && (!best || root.length > best.root.length)) {
      best = { ...source, root };
    }
  }
  return {
    namespace: best?.namespace ?? "unknown",
    ...(best?.app ? { app: best.app } : {}),
  };
}

function searchCwdFromFile(file) {
  if (sourceIdentity(file).namespace === "owner-operator") {
    const provenance = latestOwnerOperatorProvenance(fs.readFileSync(file, "utf8"));
    if (provenance) return provenance.callerCwd;
  }
  return firstCwdFromFile(file);
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

/** The id Owner Operator's database and deep links carry, given a transcript filename stem. */
function stableSessionId(stem) {
  return /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)
    ? stem.slice(stem.indexOf("_") + 1)
    : stem;
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

function printHelp() {
  process.stdout.write(
    "Usage: oo search (--query TEXT | --skim ID | --session ID --at INDEX) [options]\n" +
    "Default discovery searches configured coding-agent stores plus Owner Operator history.\n" +
    "  --owner-operator              search Owner Operator history only\n" +
    "  --target-type claude|codex|pi search that coding transcript format only\n" +
    "  --target-root DIR          narrow to a configured transcript-store root\n" +
    "  --include-tools           include tool calls/results\n" +
    "  --include-skill-bodies    include injected skill documentation, excluded by default\n" +
    "  --until TIME              close a --since time window\n" +
    "  --focus TEXT              center an anchored window on text inside a long message\n" +
    "  --json                    machine-readable query results\n" +
    "  --from-session ID         (oo search) the calling coding session, excluded from discovery\n" +
    "  --help, -h                 show this help\n",
  );
}

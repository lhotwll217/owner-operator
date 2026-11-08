#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SESSION_SEARCH_PASSTHROUGH_VALUE_FLAGS } from "./flags.mjs";
import { SEARCH_HELP } from "./help.mjs";
import {
  detectAgentsview,
  hitMatcher,
  messageForHit,
  searchAgentsview,
  stableIdOf,
  transcriptMessages,
} from "./agentsview.mjs";
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

// session-grep.mjs CONTEXT_PREVIEW_CHARS: the preview length of a hit's neighboring messages.
const CONTEXT_PREVIEW_CHARS = 180;
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
let backend = "auto";
let semantic = false;
let hybrid = false;
let sourceFile = null;
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
  else if (arg === "--backend") backend = takeValue(arg, ++index);
  else if (arg === "--semantic") semantic = true;
  else if (arg === "--hybrid") hybrid = true;
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
if (!["auto", "agentsview", "session-grep"].includes(backend)) fail("--backend must be auto, agentsview, or session-grep");
if (semantic && hybrid) fail("--semantic and --hybrid are mutually exclusive");
if ((semantic || hybrid) && !hasQuery) fail("--semantic and --hybrid need --query");
if ((semantic || hybrid) && passthrough.includes("--regex")) fail("--regex cannot be combined with --semantic or --hybrid");
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
sourceFile = path.join(os.tmpdir(), `oo-session-search-${process.pid}.json`);
fs.writeFileSync(sourceFile, JSON.stringify(sources));

const blacklist = loadBlacklist(ooHome);
const excludePatterns = pathSlugs(blacklist).map((slug) => {
  const escaped = escapeRegex(slug);
  return `(?:^|/)${escaped}(?:-[^/]*)?/[^/]+\\.jsonl$`;
});
// The same project-folder rule, for transcripts agentsview names (they bypass the primitive).
const slugExclusions = excludePatterns.map((pattern) => new RegExp(pattern));
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
// Discovery queries go to agentsview when its daemon is running and the request needs nothing
// agentsview cannot answer; everything else, and every fallback, runs session-grep as before.
const engine = browse ? { name: "session-grep" }
  : scopedQuery ? { name: "session-grep", ...(semantic || hybrid ? { reason: "--session runs on session-grep" } : {}) }
  // With no --query there is nothing to send agentsview; session-grep reports the usage error.
  : !hasQuery ? { name: "session-grep" }
  : chooseEngine();
if (engine.name === "session-grep" && (semantic || hybrid)) passthrough.push("--any");
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
    let output = null;
    let blacklistedDropped = 0;
    let fallbackReason = engine.reason ?? null;
    if (engine.name === "agentsview") {
      try {
        ({ output, blacklistedDropped } = await agentsviewOutput(engine.url));
      } catch (error) {
        if (backend === "agentsview") fail(`agentsview search failed: ${error.message}`);
        fallbackReason = `agentsview search failed: ${error.message}`;
        if (semantic || hybrid) passthrough.push("--any");
      }
    }
    if (!output) {
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
        output = JSON.parse(result.stdout);
        if (output.session) output.session = stableSessionId(output.session);
        const allowed = [];
        const entries = candidates ? output.candidates ?? [] : output.matches ?? [];
        for (const entry of entries) {
          const file = transcriptFileFor(entry);
          if (!file || fileBlacklisted(file)) {
            blacklistedDropped += 1;
            continue;
          }
          const identified = { ...entry, id: stableSessionId(entry.id), ...sourceIdentity(file) };
          allowed.push(candidates ? { ...identified, repo: repoOf(file) } : identified);
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
        const note = [
          fallbackReason,
          semantic || hybrid ? `--${semantic ? "semantic" : "hybrid"} ran as --any` : null,
        ].filter(Boolean).join("; ");
        output.backend = { name: "session-grep", ...(note ? { note } : {}) };
      }
    }
    if (output) {
      output.discoverySessionExclusions = sessionExcludeArgs.length
        ? { applied: true, sessionIds: discoverySessionIds }
        : directRead
          ? { applied: false, reason: "explicit stable-session scope; session exclusion is discovery-only" }
          : { applied: false, reason: "current OO and caller session ids unavailable" };
      if (blacklistedDropped) output.blacklistedDropped = blacklistedDropped;

      process.stdout.write(withinBudget(output, (fitted) => json
        ? `${JSON.stringify(fitted)}\n`
        : renderText(fitted, { targetType, blacklistedDropped })));
    }
  }
} finally {
  try { fs.unlinkSync(sourceFile); } catch { /* best effort */ }
}

function chooseEngine() {
  if (backend === "session-grep") return { name: "session-grep" };
  const unsupported = ownerOperator ? "--owner-operator"
    : targetRoot ? "--target-root"
    : passthrough.includes("--any") && !semantic && !hybrid ? "--any"
    : passthrough.includes("--case-sensitive") ? "--case-sensitive"
    : passthrough.includes("--include-skill-bodies") ? "--include-skill-bodies"
    : (valueOf("--sort") ?? "newest") !== "newest" ? `--sort ${valueOf("--sort")}`
    : null;
  if (unsupported) {
    if (backend === "agentsview") fail(`--backend agentsview does not support ${unsupported}`);
    return { name: "session-grep", reason: `agentsview does not support ${unsupported}` };
  }
  const detected = detectAgentsview();
  if (detected.url) return { name: "agentsview", url: detected.url };
  if (backend === "agentsview") fail(`--backend agentsview: agentsview ${detected.unavailable}`);
  return { name: "session-grep", reason: `agentsview ${detected.unavailable}` };
}

/** Discovery through agentsview, shaped like the primitive's JSON so the wrapper's budget and
 * rendering stay shared. agentsview ranks the hits; each one is located in Owner Operator's own
 * transcript stores, checked against the blacklist, and numbered as session-grep numbers it, so
 * its id and idx open the same message with `--session ID --at IDX`. Hits that cannot be located
 * or numbered are dropped and counted, never shown without a working pointer. */
async function agentsviewOutput(url) {
  const query = valueOf("--query");
  const regex = passthrough.includes("--regex");
  const includeTools = passthrough.includes("--include-tools");
  const role = valueOf("--role") ?? "all";
  const before = Number(valueOf("--before") ?? 1);
  const after = Number(valueOf("--after") ?? 1);
  const since = valueOf("--since");
  const until = valueOf("--until");
  const sinceTime = since == null ? null : parseSince(since);
  const untilTime = until == null ? null : parseUntil(until);
  if (since != null && sinceTime == null) fail("--since must be today, Nd, or YYYY-MM-DD");
  if (until != null && untilTime == null) fail("--until must be today, Nd, or YYYY-MM-DD");
  const mode = semantic ? "semantic" : hybrid ? "hybrid" : regex ? "regex" : "substring";
  const request = {
    // session-grep regexes are case-insensitive unless --case-sensitive, which stays on session-grep.
    query: regex && !query.startsWith("(?i)") ? `(?i)${query}` : query,
    mode,
    limit: Math.min(500, limit * (candidates ? 5 : 3)),
    agent: targetType === "all" ? "claude,codex,pi" : targetType,
    includeTools,
    // agentsview filters by session activity, a superset of the messages in the window; the
    // per-message bounds below make the window exact.
    activeSince: sinceTime == null ? null : new Date(sinceTime).toISOString(),
    // date_to is an inclusive UTC calendar day, so the cutoff's day covers every message before it.
    activeUntil: untilTime == null ? null : new Date(untilTime).toISOString().slice(0, 10),
  };

  const matcherFor = hitMatcher({ mode, query });
  const transcripts = transcriptIndex();
  const parsed = new Map();
  const seen = new Set();
  const located = [];
  let blacklistedDropped = 0;
  let outsideSourcesDropped = 0;
  let unmappedDropped = 0;
  let toolHitsDropped = 0;
  let skillBodyHitsDropped = 0;
  // Policy and mapping drop hits after agentsview ranks them, so read a few more pages, as the
  // session-grep path over-fetches for its blacklist, rather than return a short page.
  let cursor = 0;
  let pages = 0;
  const wanted = () => candidates ? new Set(located.map((entry) => entry.id)).size : located.length;
  do {
    const page = await searchAgentsview(url, { ...request, cursor });
    cursor = page.nextCursor;
    pages += 1;
    locate(page.matches);
  } while (cursor && pages < 4 && wanted() < limit);

  function locate(hits) {
  for (const hit of hits) {
    const id = stableIdOf(hit.session_id);
    if (discoverySessionIds.includes(id)) continue;
    const transcript = transcripts.get(id);
    if (!transcript) {
      outsideSourcesDropped += 1;
      continue;
    }
    if (fileBlacklisted(transcript.file) || slugExclusions.some((pattern) => pattern.test(transcript.file))) {
      blacklistedDropped += 1;
      continue;
    }
    if (!parsed.has(transcript.file)) {
      parsed.set(transcript.file, transcriptMessages(transcript.file, transcript.type, { includeTools }));
    }
    const messages = parsed.get(transcript.file);
    const found = messageForHit(messages, hit, matcherFor(hit));
    if (!found) {
      unmappedDropped += 1;
      continue;
    }
    if (found.hidden) {
      toolHitsDropped += 1;
      continue;
    }
    const { message } = found;
    if (message.skillBody) {
      skillBodyHitsDropped += 1;
      continue;
    }
    if (role !== "all" && message.role !== role) continue;
    if (sinceTime != null && !(message.time >= sinceTime)) continue;
    if (untilTime != null && !(message.time < untilTime)) continue;
    const key = `${id}\0${message.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    located.push({ hit, id, transcript, messages, message });
  }
  }

  const terms = (hit) => [String(hit.snippet ?? "").replace(/^\.{3}|\.{3}$/g, "").trim().slice(0, 40), regex ? "" : query]
    .filter(Boolean);
  const output = {
    query,
    backend: { name: "agentsview", mode },
    ...(regex ? { regex: true } : {}),
    moreAvailable: !!cursor,
  };
  if (candidates) {
    const sessions = new Map();
    for (const entry of located) {
      const session = sessions.get(entry.id);
      if (session) session.hitCount += 1;
      else sessions.set(entry.id, { ...entry, hitCount: 1 });
    }
    const shown = [...sessions.values()].slice(0, limit);
    const preview = previewChars(shown.length, 0);
    output.candidates = shown.map(({ hit, id, transcript, message, hitCount }) => ({
      source: transcript.type,
      id,
      index: message.index,
      timestamp: message.timestamp,
      hitCount,
      ...(hit.score != null ? { score: hit.score } : {}),
      path: transcript.file,
      match: { role: message.role, text: keepSpan(message.text, terms(hit), preview), timestamp: message.timestamp },
      ...sourceIdentity(transcript.file),
      repo: repoOf(transcript.file),
    }));
    output.candidateSessionsAtLeast = sessions.size;
  } else {
    const shown = located.slice(0, limit);
    const preview = previewChars(shown.length, before + after);
    output.matches = shown.map(({ hit, id, transcript, messages, message }) => {
      const view = messages.filter((candidate) => candidate.text);
      const at = view.findIndex((candidate) => candidate.index >= message.index);
      const end = at < 0 ? view.length : at;
      const context = (candidate) => ({ role: candidate.role, text: truncate(candidate.text, CONTEXT_PREVIEW_CHARS), timestamp: candidate.timestamp });
      return {
        source: transcript.type,
        id,
        index: message.index,
        timestamp: message.timestamp,
        ...(hit.score != null ? { score: hit.score } : {}),
        path: transcript.file,
        before: view.slice(Math.max(0, end - before), end).map(context),
        match: { role: message.role, text: keepSpan(message.text, terms(hit), preview), timestamp: message.timestamp },
        after: view.slice(view[end]?.index === message.index ? end + 1 : end).slice(0, after).map(context),
        ...sourceIdentity(transcript.file),
      };
    });
    output.matchesAtLeast = located.length;
  }
  output.shown = (output.candidates ?? output.matches).length;
  if (outsideSourcesDropped) output.outsideSourcesDropped = outsideSourcesDropped;
  if (unmappedDropped) output.unmappedDropped = unmappedDropped;
  if (toolHitsDropped) output.toolHitsDropped = toolHitsDropped;
  if (skillBodyHitsDropped) output.skillBodyHitsDropped = skillBodyHitsDropped;
  return { output, blacklistedDropped };
}

// The primitive's per-entry preview budget (session-grep.mjs CONTEXT_PREVIEW_CHARS and the
// matchPreviewChars arithmetic), so both engines spend --max-chars alike.
function previewChars(count, contextMessages) {
  const competing = Math.max(1, count);
  const fairShare = Math.floor((maxChars - 300) / competing);
  const maxHitShare = competing > 1 ? Math.max(300, Math.floor(maxChars / 3)) : Math.max(300, maxChars - 300);
  const entryShare = Math.min(maxHitShare, Math.max(300, fairShare));
  return Math.max(300, entryShare - 220 - contextMessages * (CONTEXT_PREVIEW_CHARS + 20));
}

function truncate(text, chars) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > chars ? `${flat.slice(0, chars - 3)}...` : flat;
}

/** Every transcript in the configured sources by the stable id Owner Operator and agentsview
 * share: the filename stem, the UUID ending a Codex rollout name, or the id after Pi's timestamp. */
function transcriptIndex() {
  const index = new Map();
  for (const { type, root } of sources) {
    for (const file of walk(root)) {
      const stem = path.basename(file, ".jsonl");
      const id = type === "codex"
        ? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(stem)?.[1] ?? stem
        : stableSessionId(stem);
      if (!index.has(id)) index.set(id, { file, type });
    }
  }
  return index;
}

function repoOf(file) {
  try { return resolveRepo(searchCwdFromFile(file)); } catch { return null; /* best effort label */ }
}

function valueOf(flag) {
  const at = passthrough.indexOf(flag);
  return at < 0 ? undefined : passthrough[at + 1];
}

// session-grep's --since/--until grammar (session-grep.mjs parseSince/parseUntil): local days.
function parseSince(value) {
  const now = new Date();
  if (value === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = /^(\d+)d$/.exec(value);
  if (days) return now.getTime() - Number(days[1]) * 86_400_000;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00`);
  return null;
}

function parseUntil(value) {
  const start = parseSince(value);
  if (start == null) return null;
  return /^\d+d$/.test(value) ? start : start + 86_400_000;
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
  const backendNote = output.backend?.note ? ` backend_note=${JSON.stringify(output.backend.note)}` : "";
  if (output.backend?.name === "agentsview") {
    // agentsview pages results without totals: report what this page proved, not a total.
    say(
      `query=${JSON.stringify(output.query ?? "")} backend=agentsview mode=${output.backend.mode} shown=${output.shown ?? 0}` +
      (output.candidates
        ? ` candidate_sessions_at_least=${output.candidateSessionsAtLeast ?? 0}`
        : ` message_matches_at_least=${output.matchesAtLeast ?? 0}`) +
      ` more_available=${output.moreAvailable ? "true" : "false"}` +
      `${output.regex ? " regex=true" : ""}` +
      `${output.outsideSourcesDropped ? ` outside_sources_dropped=${output.outsideSourcesDropped}` : ""}` +
      `${output.unmappedDropped ? ` unmapped_dropped=${output.unmappedDropped}` : ""}` +
      `${output.toolHitsDropped ? ` tool_hits_dropped=${output.toolHitsDropped} (add --include-tools)` : ""}` +
      `${output.skillBodyHitsDropped ? ` skill_body_hits_dropped=${output.skillBodyHitsDropped} (add --include-skill-bodies)` : ""}` +
      `${context.targetType !== "all" ? ` target_type=${context.targetType}` : ""}` +
      `${context.blacklistedDropped ? ` blacklisted_dropped=${context.blacklistedDropped}` : ""} ` +
      `discovery_session_exclusions=${sessionExclusions}`,
    );
  } else say(
    `query=${JSON.stringify(output.query ?? "")} total_message_matches=${output.totalMatches ?? 0} ` +
    `files_with_matches=${output.filesWithMatches ?? 0} shown=${output.shown ?? 0}` +
    `${output.session ? ` session=${output.session}` : ""}${output.any ? " any=true" : ""}` +
    `${output.literalMultiword ? " literal_multiword=true (retry with --any; literal phrases rarely occur verbatim)" : ""}` +
    `${output.excluded?.tools ? ` tools_excluded=${output.excluded.tools} (add --include-tools)` : ""}` +
    `${output.excluded?.skillBodies ? ` skill_excluded=${output.excluded.skillBodies} (add --include-skill-bodies)` : ""}` +
    candidateCount +
    `${context.targetType !== "all" ? ` target_type=${context.targetType}` : ""}` +
    `${context.blacklistedDropped ? ` blacklisted_dropped=${context.blacklistedDropped}` : ""} ` +
    `discovery_session_exclusions=${sessionExclusions}` +
    `${output.backend ? ` backend=session-grep${backendNote}` : ""}`,
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
    const rank = match.matchedWords
      ? ` matched=[${match.matchedWords.join(",")}] score=${match.score}`
      : match.score != null ? ` score=${Number(match.score).toFixed(4)}` : "";
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
    say(output.backend?.name === "agentsview"
      ? "\nhint: candidates group the hits agentsview returned by stable session id; use --skim ID or --session ID --at BEST_IDX to inspect one"
      : "\nhint: candidates group all ranked message hits by stable session id before limits; use --skim ID or --session ID --at BEST_IDX to inspect one");
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
  if (sourceFile) try { fs.unlinkSync(sourceFile); } catch { /* best effort */ }
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function takeValue(flag, index, { allowLeadingDashes = false } = {}) {
  const value = input[index];
  if (!value || (!allowLeadingDashes && value.startsWith("--"))) fail(`${flag} needs a value`);
  return value;
}

function printHelp() {
  process.stdout.write(`${SEARCH_HELP}\n`);
}

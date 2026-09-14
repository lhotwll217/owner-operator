#!/usr/bin/env node
// session-grep — literal/regex grep across AI coding-session transcripts (Claude Code,
// Codex, Pi) returning bounded MESSAGE context around each hit, not raw JSONL lines.
// Extracted from owner-operator's sessions-grep skill; standalone here so it can be
// shared, vendored back into wrappers, and continuously eval-tuned (see eval/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configuredSourceOf, loadSessionSources } from './sources.mjs';

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const args = process.argv.slice(2);
const opts = { limit: 20, before: 1, after: 1, role: 'all', sort: 'newest', json: false, regex: false, roots: [], targetTypes: [], targetRoots: [], excludeRe: [], excludeSessions: [], maxChars: 8000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--query') opts.query = args[++i];
  else if (a === '--limit') opts.limit = Number(args[++i]);
  else if (a === '--before') { opts.before = Number(args[++i]); opts.beforeSet = true; }
  else if (a === '--after') { opts.after = Number(args[++i]); opts.afterSet = true; }
  else if (a === '--role') opts.role = args[++i];
  else if (a === '--target-type') opts.targetTypes.push(args[++i]);
  else if (a === '--source') opts.targetTypes.push(args[++i]);
  else if (a === '--since') opts.since = args[++i];
  else if (a === '--sort') opts.sort = args[++i];
  else if (a === '--root') opts.roots.push(args[++i]);
  else if (a === '--sources-file') opts.sourcesFile = args[++i];
  else if (a === '--target-root') opts.targetRoots.push(args[++i]);
  else if (a === '--exclude-re') opts.excludeRe.push(args[++i]);
  else if (a === '--exclude-session') opts.excludeSessions.push(args[++i]);
  else if (a === '--max-chars') { opts.maxChars = Number(args[++i]); opts.maxCharsSet = true; }
  else if (a === '--overview') opts.overview = true;
  else if (a === '--skim') opts.skim = args[++i];
  else if (a === '--session') opts.session = args[++i];
  else if (a === '--at') opts.at = Number(args[++i]);
  else if (a === '--list-roots') opts.listRoots = true;
  else if (a === '--self-test') opts.selfTest = true;
  else if (a === '--include-tools') opts.includeTools = true;
  else if (a === '--any') opts.any = true;
  else if (a === '--candidates') opts.candidates = true;
  else if (a === '--regex') opts.regex = true;
  else if (a === '--case-sensitive') opts.caseSensitive = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--help' || a === '-h') usage(0);
  else usage(1, `Unknown arg: ${a}`);
}

// ─── FORMAT ADAPTERS ────────────────────────────────────────────────────────
// Loaded from the adapters/ folder next to this script — one file per session
// format, each exporting {name, detect(file), message(record, opts), fallback?}.
// Supporting a new JSONL-based tool = dropping one file in that folder (plus a
// --self-test fixture below). `--target-type` values and dispatch derive from what's
// loaded. Non-JSONL formats (Cursor's sqlite, opencode's split JSON) also need a
// reader change here; see SKILL.md "Onboarding" for the format map.
import { fileURLToPath, pathToFileURL } from 'node:url';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS = {};
{
  const dir = path.join(scriptDir, 'adapters');
  const loaded = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    if (mod.default?.name && mod.default.detect && mod.default.message) loaded.push(mod.default);
  }
  loaded.sort((a, b) => (a.fallback ? 1 : 0) - (b.fallback ? 1 : 0)); // fallbacks last
  for (const a of loaded) ADAPTERS[a.name] = a;
}
// ────────────────────────────────────────────────────────────────────────────

if (opts.selfTest) {
  process.exit(await selfTest());
}
if (opts.at != null && !opts.session) usage(1, '--at requires --session ID_PREFIX');
if (opts.session && opts.at == null && !opts.query) usage(1, '--session requires --query TEXT or --at INDEX');
const modes = [
  ['--query', !!opts.query],
  ['--overview', !!opts.overview],
  ['--skim', !!opts.skim],
  ['--session/--at', !!opts.session && opts.at != null],
  ['--list-roots', !!opts.listRoots],
].filter(([, selected]) => selected).map(([name]) => name);
if (!modes.length) usage(1, 'Missing --query (or use --overview / --skim ID / --session ID --at INDEX)');
if (modes.length > 1) usage(1, `choose exactly one mode; received ${modes.join(' and ')}`);
if (opts.roots.length && opts.sourcesFile) usage(1, '--root and --sources-file cannot be combined: --root is an untyped one-off override; use --target-root with --sources-file to narrow configured typed roots');
if (!Number.isFinite(opts.limit) || opts.limit < 1) usage(1, '--limit must be >= 1');
if (!Number.isFinite(opts.maxChars) || opts.maxChars < 500) usage(1, '--max-chars must be >= 500');
if (!Number.isFinite(opts.before) || opts.before < 0) usage(1, '--before must be >= 0');
if (!Number.isFinite(opts.after) || opts.after < 0) usage(1, '--after must be >= 0');
if (!['all', 'user', 'assistant'].includes(opts.role)) usage(1, '--role must be all, user, or assistant');
const targetTypes = new Set(opts.targetTypes.filter((type) => type !== 'all'));
for (const type of targetTypes) {
  if (!ADAPTERS[type]) usage(1, `--target-type must be all or one of: ${Object.keys(ADAPTERS).join(', ')}`);
}
if (!['newest', 'oldest', 'file'].includes(opts.sort)) usage(1, '--sort must be newest, oldest, or file');
const sinceTime = opts.since ? parseSince(opts.since) : null;
if (opts.since && sinceTime == null) usage(1, '--since must be today, Nd, or YYYY-MM-DD');
if (opts.any && opts.regex) usage(1, '--any and --regex cannot be combined');
if (opts.candidates && !opts.query) usage(1, '--candidates requires --query');
if (opts.excludeSessions.some((id) => typeof id !== 'string' || !id.trim())) usage(1, '--exclude-session requires a non-empty ID prefix');
const queryPattern = opts.regex ? normalizeQueryRegex(opts.query, opts.caseSensitive) : opts.query;
const queryRegex = opts.regex ? compileRegex(queryPattern, opts.caseSensitive) : null;

// --exclude-re: path-based exclusion, applied wherever session files are enumerated
// (search, browse, window mode) so an excluded transcript can never surface. This is
// the hook wrappers use to enforce a blacklist (e.g. owner-operator's privacy layer);
// patterns are JS regexes tested against the full file path.
const excludeRes = opts.excludeRe.map((p) => {
  if (typeof p !== 'string' || !p.length) usage(1, '--exclude-re requires a regex argument');
  try {
    return new RegExp(p);
  } catch (error) {
    usage(1, `--exclude-re: invalid JavaScript regex ${JSON.stringify(p)}: ${error.message}`);
  }
});
const isExcluded = (file) => excludeRes.some((re) => re.test(file));
const isExcludedSession = (file) =>
  opts.excludeSessions.some((prefix) => sessionId(file).startsWith(prefix));

// --any: multi-word phrases rarely occur verbatim in transcripts, so match ANY word
// and rank by how many distinct words a message hits. Low-signal words are dropped
// from the word set so common glue doesn't dominate the ranking.
const STOPWORDS = new Set(['the', 'and', 'was', 'were', 'did', 'does', 'you', 'your', 'why', 'how', 'what', 'when', 'where', 'which', 'who', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'are', 'not', 'but', 'about', 'into', 'out', 'our', 'they', 'them', 'then', 'than', 'its', 'get', 'got', 'can', 'could', 'would', 'should', 'ever', 'any', 'all', 'some', 'there']);
let anyWords = null;
if (opts.any) {
  // Agents commonly express OR alternatives with pipes even though --any already owns
  // the OR semantics. Treat pipes as delimiters rather than silently searching for
  // impossible fixed strings such as "federation|graphql".
  const raw = opts.query.split(/[\s|]+/).filter(Boolean);
  const strong = raw.filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  // Dedupe: repeated words must not double-count df or score.
  anyWords = [...new Set((strong.length ? strong : raw).map((w) => (opts.caseSensitive ? w : w.toLowerCase())))];
  if (!anyWords.length) usage(1, '--any needs at least one query word');
}

// Built-in default roots, searched when SESSION_GREP_SOURCES_FILE is unset. These are
// the standard per-user homes for each tool; roots that don't exist are skipped, so
// zero config works out of the box. To search a relocated store or a new tool: add an
// adapter in adapters/ and a line here (this file is yours to edit — the skill is
// vendored via `npx skills add`), or point --sources-file / SESSION_GREP_SOURCES_FILE at a
// JSON array of { type, root }, or pass --root DIR for one call. See SKILL.md "Onboarding".
const DEFAULT_SOURCES = [
  { type: 'claude', root: '~/.claude/projects' },
  { type: 'codex', root: '~/.codex/sessions' },
  { type: 'codex', root: '~/.codex/archived_sessions' },
  { type: 'pi', root: '~/.pi/agent/sessions' },
];
const sourceNames = Object.keys(ADAPTERS);
let sourceMap = loadSessionSources({
  knownSources: sourceNames,
  defaultSources: DEFAULT_SOURCES,
  rootOverrides: opts.roots,
  env: { ...process.env, ...(opts.sourcesFile ? { SESSION_GREP_SOURCES_FILE: opts.sourcesFile } : {}) },
});
const configErrorReason = (error) => ({ missing: 'does not exist', unparseable: 'is not valid JSON', 'not-an-array': 'must be a JSON array of { type, root }' }[error] ?? 'could not be used');
// Ambient env config falls back with a warning for compatibility; an explicit
// --sources-file is a per-call contract and must fail closed.
if (sourceMap.configError) {
  const why = configErrorReason(sourceMap.configError);
  if (opts.sourcesFile) usage(1, `--sources-file ${sourceMap.configPath} ${why}`);
  console.error(`session-grep: warning: SESSION_GREP_SOURCES_FILE ${sourceMap.configPath} ${why} — using built-in defaults (see --list-roots)`);
}
if (opts.targetRoots.length) {
  const wanted = new Set(opts.targetRoots.map((root) => path.resolve(expandHome(root))));
  const filtered = sourceMap.roots.filter((entry) => wanted.has(path.resolve(entry.root)));
  if (!filtered.length) {
    usage(1, `--target-root did not match any configured roots. Known roots: ${sourceMap.roots.map((entry) => entry.root).join(', ')}`);
  }
  sourceMap = { ...sourceMap, roots: filtered };
}
const roots = sourceMap.roots.map((entry) => entry.root).filter((dir) => fs.existsSync(dir));
if (opts.listRoots) {
  console.log(`origin=${sourceMap.origin}`);
  console.log(`config=${sourceMap.configPath ?? '(none)'}`);
  if (sourceMap.configError) console.log(`config_error=true (${sourceMap.configError}; using built-in defaults)`);
  for (const entry of sourceMap.roots) console.log(`${entry.type}\texists=${fs.existsSync(entry.root)}\t${entry.root}`);
  process.exit(0);
}
if (!roots.length) usage(1, 'No session roots found to search — edit DEFAULT_SOURCES / pass --sources-file / set SESSION_GREP_SOURCES_FILE (see SKILL.md "Onboarding") or pass --root DIR');

// Browse modes answer "which session?" and "what happened in it?" in one call each —
// whole-thread questions shouldn't cost 20 grep probes. A skim substitutes for many
// probe calls, so it gets a roomier default budget.
if (opts.skim && !opts.maxCharsSet) opts.maxChars = 16000;
if (opts.overview || opts.skim) {
  browse();
  process.exit(0);
}

// Window mode: consume a hit's pointer. Every search hit prints `id=... idx=...`;
// `--session ID --at IDX` returns the exact messages around that index — drill-in
// without re-running the search. Context defaults widen to ±5 here (that's the point).
if (opts.session && opts.at != null) {
  if (!Number.isFinite(opts.at) || opts.at < 0) usage(1, '--at must be a message index >= 0 (from a hit\'s idx= field)');
  const file = allSessionFiles().find((f) => sessionId(f).startsWith(opts.session));
  if (!file) usage(1, `No session file matching id prefix "${opts.session}" under: ${roots.join(', ')}`);
  const messages = parseMessages(fs.readFileSync(file, 'utf8'), sourceOf(file));
  if (opts.at >= messages.length) {
    usage(1, `--at ${opts.at} out of range: session ${sessionId(file)} has ${messages.length} messages (0..${messages.length - 1}). Note: indexes depend on --include-tools — drill in with the same setting the search used.`);
  }
  const b = opts.beforeSet ? opts.before : 5;
  const a = opts.afterSet ? opts.after : 5;
  const from = Math.max(0, opts.at - b);
  const to = Math.min(messages.length - 1, opts.at + a);
  console.log(`window id=${sessionId(file)} messages ${from}..${to} of ${messages.length} path=${file}`);
  const lineFor = (i, cap) => {
    const m = messages[i];
    return `[${i}]${i === opts.at ? '*' : ' '} ${m.role}${m.timestamp ? ' ' + String(m.timestamp).slice(0, 16) : ''}: ${truncate(m.text, cap)}`;
  };
  // Reserve the selected message first, then spend what remains on the nearest context.
  // Selection happens before chronological rendering, so a tight budget can never consume
  // five lead-in previews and throw away the stable pointer's actual evidence.
  const contextReserve = Math.min(2_000, Math.floor(opts.maxChars * 0.35));
  const targetCap = Math.max(80, opts.maxChars - contextReserve - 120);
  const selected = new Map([[opts.at, lineFor(opts.at, targetCap)]]);
  let size = selected.get(opts.at).length;
  for (let distance = 1; selected.size < to - from + 1; distance++) {
    const nearby = [opts.at - distance, opts.at + distance]
      .filter((index) => index >= from && index <= to);
    if (!nearby.length) break;
    for (const index of nearby) {
      const line = lineFor(index, 300);
      if (size + line.length + 1 <= opts.maxChars) {
        selected.set(index, line);
        size += line.length + 1;
      }
    }
  }
  for (const index of [...selected.keys()].sort((left, right) => left - right)) {
    console.log(selected.get(index));
  }
  if (selected.size < to - from + 1) {
    console.log(`... window context truncated by --max-chars; selected [${opts.at}] retained`);
  }
  process.exit(0);
}

// Once discovery returns a stable ID, a narrower query should stay inside that session
// instead of reopening global search or forcing a large skim. This is a query scope, not
// a second command mode; --query + --session + --at remains ambiguous and fails above.
let scopedSessionFile = null;
if (opts.query && opts.session) {
  const scoped = allSessionFiles().filter((file) => sessionId(file).startsWith(opts.session));
  if (!scoped.length) usage(1, `No session file matching id prefix "${opts.session}" under: ${roots.join(', ')}`);
  if (scoped.length > 1) usage(1, `Session id prefix "${opts.session}" is ambiguous across ${scoped.length} files; provide a longer stable ID`);
  [scopedSessionFile] = scoped;
}

const rg = spawnSync('rg', [
  ...(opts.caseSensitive ? [] : ['-i']),
  ...(opts.regex ? [] : ['--fixed-strings']),
  '--files-with-matches',
  '--glob',
  '*.jsonl',
  ...(anyWords ? [...anyWords.flatMap((w) => ['-e', w]), '--'] : ['--', queryPattern]),
  ...(scopedSessionFile ? [scopedSessionFile] : roots),
], { encoding: 'utf8' });

if (rg.error) {
  usage(1, `ripgrep (rg) is required but could not be run (${rg.error.code ?? rg.error.message}). Install it, e.g. \`brew install ripgrep\`.`);
}
let files;
if (rg.status === 2 && opts.regex) {
  // A JS-valid regex that ripgrep's engine rejects (lookaround, backrefs) must not
  // die at the prefilter — fall back to scanning every session file with the JS matcher.
  files = allSessionFiles();
} else if (rg.status === 2) {
  const detail = rg.stderr.trim() ? `\n${rg.stderr.trim()}` : '';
  usage(1, `Invalid query for ripgrep.${detail}`);
} else {
  files = rg.status === 0 ? rg.stdout.trim().split('\n').filter(Boolean) : [];
}
files = files.filter((f) => !isExcluded(f) && !isExcludedSession(f));
const matches = [];
const q = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
// --any rarity stats: document frequency per word across scanned messages. Rare words
// are the signal; the ranking weights them (IDF) and the output reports the counts so
// the caller learns which of its words are low-signal.
const wordDf = anyWords ? Object.fromEntries(anyWords.map((w) => [w, 0])) : null;
let messagesScanned = 0;

for (const file of files) {
  const source = sourceOf(file);
  if (targetTypes.size && !targetTypes.has(source)) continue;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const messages = parseMessages(raw, source);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    messagesScanned++;
    const haystack = opts.caseSensitive ? msg.text : msg.text.toLowerCase();
    let hitWords = null;
    if (anyWords) {
      hitWords = anyWords.filter((w) => haystack.includes(w));
      for (const w of hitWords) wordDf[w]++;
      if (!hitWords.length) continue;
    }
    if (opts.role !== 'all' && msg.role !== opts.role) continue;
    if (!anyWords && (opts.regex ? !queryRegex.test(msg.text) : !haystack.includes(q))) continue;
    const time = timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? fs.statSync(file).mtimeMs;
    if (sinceTime != null && time < sinceTime) continue;
    matches.push({
      source,
      id: sessionId(file),
      path: file,
      index: i,
      timestamp: msg.timestamp,
      time,
      ...(anyWords ? { matchedWords: hitWords } : {}),
      before: messages.slice(Math.max(0, i - opts.before), i),
      match: msg,
      after: messages.slice(i + 1, i + 1 + opts.after),
    });
  }
}

// With --any, rank by summed word rarity (IDF): a hit on one rare identifier beats a
// hit on three ubiquitous words. Recency breaks ties.
if (anyWords) {
  const idf = (w) => Math.log((messagesScanned + 1) / (wordDf[w] + 1));
  for (const m of matches) m.score = round3(m.matchedWords.reduce((t, w) => t + idf(w), 0));
  matches.sort((a, b) => b.score - a.score || (opts.sort === 'oldest' ? a.time - b.time : b.time - a.time));
} else if (opts.sort === 'newest') matches.sort((a, b) => b.time - a.time);
else if (opts.sort === 'oldest') matches.sort((a, b) => a.time - b.time);
const candidates = opts.candidates ? groupCandidates(matches) : null;
const rankedEntries = candidates ?? matches;
const limited = rankedEntries.slice(0, opts.limit);

// Zero hits should steer the next query, not dead-end the agent: multi-word literal
// phrases almost never occur verbatim in transcripts — say so and point at --any.
const hint = !limited.length
  ? (!opts.any && opts.query.trim().split(/\s+/).length > 1 && !opts.regex
      ? 'no hits: multi-word phrases rarely occur verbatim in transcripts — retry with --any (matches any word, ranked by words matched), or grep ONE rare term (an identifier, error string, or filename)'
      : opts.any
        ? 'no hits for any query word: try different, rarer words (identifiers, error strings, filenames), or loosen --since/--role filters'
        : 'no hits: try a rarer single term, or --any with several candidate words')
  : null;

// Per-word hit counts teach the caller which of its words are low-signal: a word
// matching thousands of messages contributes nothing — drop it next query.
const wordStats = anyWords
  ? anyWords.map((w) => `${w}=${wordDf[w]}`).join(' ')
  : null;

// Output is budgeted (--max-chars, default 8k): a bad query can't flood the caller's
// context. Hits are selected in rank order until the budget runs out (an oversized
// FIRST hit is trimmed to fit rather than blowing the budget), and the header reports
// the true emitted count.
const OMIT = (n) => `... ${n} more matching ${opts.candidates ? 'sessions' : 'messages'} omitted by the ${opts.maxChars}-char output budget — ${scopedSessionFile
  ? 'stay in this --session scope; reduce --before/--after, use --sort oldest for chronology, or raise --max-chars'
  : `narrow with --role/--since${opts.any ? '/rarer words' : ''}, or raise --max-chars`}`;

const HEADER_ALLOWANCE = 300;
const CONTEXT_PREVIEW_CHARS = 180;
const MIN_MATCH_PREVIEW_CHARS = 300;
const ENTRY_OVERHEAD_CHARS = 220;
const entryShare = Math.max(
  MIN_MATCH_PREVIEW_CHARS,
  Math.floor((opts.maxChars - HEADER_ALLOWANCE) / Math.max(1, limited.length)),
);
const matchPreviewChars = (entry) => Math.max(
  MIN_MATCH_PREVIEW_CHARS,
  entryShare - ENTRY_OVERHEAD_CHARS -
    (opts.candidates ? 0 : entry.before.length + entry.after.length) * (CONTEXT_PREVIEW_CHARS + 20),
);
function selectWithinBudget(renderLen, trimContext) {
  const emitted = [];
  let size = HEADER_ALLOWANCE;
  for (const m of limited) {
    let entry = m;
    let len = renderLen(entry);
    if (size + len > opts.maxChars) {
      if (emitted.length) break;
      entry = trimContext(entry); // always emit at least the match itself, contextless
      len = renderLen(entry);
      if (size + len > opts.maxChars) break;
    }
    size += len;
    emitted.push(entry);
  }
  return emitted;
}

if (opts.json) {
  const slim = (msg, chars) => ({ role: msg.role, text: truncate(msg.text, chars), timestamp: msg.timestamp });
  const toEntry = opts.candidates
    ? (m) => ({ source: m.source, id: m.id, index: m.index, timestamp: m.timestamp, hitCount: m.hitCount, ...(anyWords ? { matchedWords: m.matchedWords, score: m.score } : {}), path: m.path, match: slim(m.match, matchPreviewChars(m)) })
    : (m) => ({ source: m.source, id: m.id, index: m.index, timestamp: m.timestamp, ...(anyWords ? { matchedWords: m.matchedWords, score: m.score } : {}), path: m.path, before: m.before.map((message) => slim(message, CONTEXT_PREVIEW_CHARS)), match: slim(m.match, matchPreviewChars(m)), after: m.after.map((message) => slim(message, CONTEXT_PREVIEW_CHARS)) });
  const emitted = selectWithinBudget(
    (m) => JSON.stringify(toEntry(m)).length,
    (m) => opts.candidates ? m : ({ ...m, before: [], after: [] }),
  ).map(toEntry);
  const omitted = limited.length - emitted.length;
  console.log(JSON.stringify({ query: opts.query, ...(scopedSessionFile ? { session: sessionId(scopedSessionFile) } : {}), regex: opts.regex, any: !!opts.any, ...(anyWords ? { wordHits: wordDf, messagesScanned } : {}), rawFilesWithHits: files.length, totalMatches: matches.length, ...(candidates ? { totalCandidateSessions: candidates.length } : {}), ...(opts.excludeSessions.length ? { excludedSessions: opts.excludeSessions } : {}), shown: emitted.length, ...(omitted ? { omittedByBudget: omitted, note: OMIT(omitted) } : {}), ...(hint ? { hint } : {}), [opts.candidates ? 'candidates' : 'matches']: emitted }));
} else {
  const renderLines = opts.candidates
    ? (m) => [
        `${m.source} id=${m.id} best_idx=${m.index} hits=${m.hitCount} ts=${m.timestamp ?? ''}${anyWords ? ` matched=[${m.matchedWords.join(',')}] best_score=${m.score}` : ''}`,
        `path=${m.path}`,
        `  BEST ${m.match.role}: ${truncate(m.match.text, matchPreviewChars(m))}`,
      ]
    : (m) => [
        `${m.source} id=${m.id} idx=${m.index} ts=${m.timestamp ?? ''}${anyWords ? ` matched=[${m.matchedWords.join(',')}] score=${m.score}` : ''}`,
        `path=${m.path}`,
        ...m.before.map((b) => `  before ${b.role}: ${truncate(b.text, CONTEXT_PREVIEW_CHARS)}`),
        `  MATCH ${m.match.role}: ${truncate(m.match.text, matchPreviewChars(m))}`,
        ...m.after.map((a) => `  after  ${a.role}: ${truncate(a.text, CONTEXT_PREVIEW_CHARS)}`),
      ];
  const emitted = selectWithinBudget(
    (m) => renderLines(m).reduce((t, l) => t + l.length + 1, 6),
    (m) => opts.candidates ? m : ({ ...m, before: [], after: [] }),
  );
  const omitted = limited.length - emitted.length;
  console.log(`query=${JSON.stringify(opts.query)}${scopedSessionFile ? ` session=${sessionId(scopedSessionFile)}` : ''}${opts.regex ? ' regex=true' : ''}${opts.any ? ` any=true` : ''}${opts.candidates ? ` candidate_sessions=${candidates.length}` : ''} raw_files_with_hits=${files.length} total_message_matches=${matches.length} shown=${emitted.length} sort=${opts.sort}${opts.since ? ` since=${opts.since}` : ''}${opts.caseSensitive ? ' case_sensitive=true' : ''}${opts.excludeSessions.length ? ` excluded_sessions=[${opts.excludeSessions.join(',')}]` : ''}`);
  if (wordStats) console.log(`word_hits: ${wordStats} (of ${messagesScanned} messages in matched files; high-count words are low-signal — prefer the rare ones)`);
  if (hint) console.log(`hint: ${hint}`);
  emitted.forEach((m, idx) => {
    const [head, ...rest] = renderLines(m);
    console.log(`\n[${idx + 1}] ${head}`);
    for (const l of rest) console.log(l);
  });
  if (omitted) console.log(`\n${OMIT(omitted)}`);
}

function groupCandidates(sortedMatches) {
  const grouped = new Map();
  for (const match of sortedMatches) {
    let candidate = grouped.get(match.id);
    if (!candidate) {
      candidate = {
        source: match.source,
        id: match.id,
        path: match.path,
        index: match.index,
        timestamp: match.timestamp,
        time: match.time,
        score: match.score,
        matchedWords: [],
        hitCount: 0,
        match: match.match,
      };
      grouped.set(match.id, candidate);
    }
    candidate.hitCount += 1;
    for (const word of match.matchedWords ?? []) {
      if (!candidate.matchedWords.includes(word)) candidate.matchedWords.push(word);
    }
  }
  return [...grouped.values()];
}

function sourceOf(file) {
  const configured = configuredSourceOf(file, sourceMap, sourceNames);
  if (configured) return configured;
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.detect(file)) return name;
  }
}

function parseMessages(raw, source) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = ADAPTERS[source].message(obj, { includeTools: opts.includeTools });
    if (!msg || !msg.text.trim()) continue;
    out.push(msg);
  }
  return out;
}

function sessionId(file) {
  const stem = path.basename(file, '.jsonl');
  // Codex stores the canonical session id in session_meta, while its standard filename
  // prefixes that UUID with a rollout timestamp. Owner Operator and other indexes retain
  // the canonical UUID, so browse/drill-in must accept that same id. Keep non-standard
  // fixture and relocated filenames unchanged rather than guessing at their structure.
  if (sourceOf(file) === 'codex') {
    const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(stem)?.[1];
    if (uuid) return uuid;
  }
  return stem;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function allSessionFiles() {
  const out = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { recursive: true })) {
      const p = path.join(root, String(entry));
      if (p.endsWith('.jsonl') && !isExcluded(p) && !isExcludedSession(p) && fs.statSync(p).isFile()) out.push(p);
    }
  }
  return out;
}

// --overview: one compact digest per session (id, dates, message counts, opening user
// prompt) so the caller can pick the right session in a single cheap call.
// --skim ID: the conversational spine of one session — user + assistant text only,
// head/tail preserved and the middle sampled evenly to fit the output budget. Indexes
// are printed so specifics can be drilled with a targeted --query afterwards.
function browse() {
  const files = allSessionFiles().filter((file) => !targetTypes.size || targetTypes.has(sourceOf(file)));
  if (opts.skim) {
    const file = files.find((f) => sessionId(f).startsWith(opts.skim));
    if (!file) usage(1, `No session file matching id prefix "${opts.skim}" under: ${roots.join(', ')}`);
    const messages = parseMessages(fs.readFileSync(file, 'utf8'), sourceOf(file));
    const line = (m, i, cap) => `[${i}] ${m.role}${m.timestamp ? ' ' + String(m.timestamp).slice(0, 16) : ''}: ${cap == null ? m.text.replace(/\s+/g, ' ').trim() : truncate(m.text, cap)}`;
    const header = `skim id=${sessionId(file)} messages=${messages.length} path=${file}`;
    // A short conversation should be lossless: --max-chars is the actual aperture. The old
    // eager 200-char clip discarded decisive facts even when the complete session was only
    // ~1KB, forcing agents into repeated synonym queries that could never recover the tail.
    const fullLines = messages.map((m, i) => line(m, i, null));
    const fullOutput = `${[header, ...fullLines].join('\n')}\n`;
    if (fullOutput.length <= opts.maxChars) {
      process.stdout.write(fullOutput);
      return;
    }
    // Large sessions retain the eval-proven sampled conversational spine.
    const lines = messages.map((m, i) => line(m, i, 200));
    const total = lines.reduce((t, l) => t + l.length + 1, 0);
    const avg = total / lines.length;
    const sampleIndexes = (keep) => {
      if (keep <= 1) return [0];
      if (keep === 2) return [0, lines.length - 1];
      // Head/tail sizes scale down with the budget; middle picks are CENTERED in their
      // strides so low sample counts do not cluster at the start of the middle.
      const edge = Math.min(10, Math.floor(keep / 3), Math.floor(lines.length / 2));
      const head = Math.max(1, edge);
      const tail = Math.min(Math.max(1, edge), lines.length - head);
      const middleKeep = Math.max(0, keep - head - tail);
      const middle = lines.length - head - tail;
      const stride = middleKeep > 0 ? middle / middleKeep : Infinity;
      const chosen = new Set();
      for (let i = 0; i < head; i++) chosen.add(i);
      for (let i = 0; i < middleKeep; i++) chosen.add(head + Math.min(middle - 1, Math.floor((i + 0.5) * stride)));
      for (let i = lines.length - tail; i < lines.length; i++) chosen.add(i);
      return [...chosen].sort((a, b) => a - b);
    };
    const renderSample = (indexes) => {
      const output = [header];
      let previous = -1;
      for (const index of indexes) {
        const skipped = index - previous - 1;
        if (skipped) output.push(`  ... ${skipped} messages sampled out (drill in with --query on anything above/below) ...`);
        output.push(lines[index]);
        previous = index;
      }
      const trailing = lines.length - previous - 1;
      if (trailing) output.push(`  ... ${trailing} messages sampled out ...`);
      return `${output.join('\n')}\n`;
    };
    // The old average-length estimate ignored headers and sampling markers, causing live
    // 20k/30k skims to render 25k/37k. Start near the estimate, then measure the complete
    // rendered result and reduce the sample until the requested aperture is truly honored.
    let keep = Math.min(lines.length, Math.max(1, Math.floor((opts.maxChars - header.length - 1) / Math.max(1, avg))));
    let sampledOutput = '';
    while (keep >= 1) {
      sampledOutput = renderSample(sampleIndexes(keep));
      if (sampledOutput.length <= opts.maxChars) break;
      keep--;
    }
    process.stdout.write(sampledOutput.length <= opts.maxChars
      ? sampledOutput
      : `${sampledOutput.slice(0, Math.max(0, opts.maxChars - 4))}...\n`);
    return;
  }

  // --overview
  const digests = [];
  for (const file of files) {
    const source = sourceOf(file);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const messages = parseMessages(raw, source);
    if (!messages.length) continue;
    const first = messages.find((m) => m.role === 'user') ?? messages[0];
    const times = messages.map((m) => timeOf(m.timestamp)).filter((t) => t != null);
    const lastTime = times.length ? Math.max(...times) : fs.statSync(file).mtimeMs;
    if (sinceTime != null && lastTime < sinceTime) continue;
    digests.push({
      id: sessionId(file),
      source,
      path: file,
      from: times.length ? new Date(Math.min(...times)).toISOString().slice(0, 16) : '?',
      to: times.length ? new Date(Math.max(...times)).toISOString().slice(0, 16) : '?',
      user: messages.filter((m) => m.role === 'user').length,
      assistant: messages.filter((m) => m.role === 'assistant').length,
      mb: (raw.length / 1e6).toFixed(1),
      opening: truncate(first.text, 220),
      lastTime,
    });
  }
  digests.sort((a, b) => b.lastTime - a.lastTime);
  console.log(`sessions=${digests.length} (newest first) — drill in with --skim ID or --query`);
  let size = 0;
  for (const d of digests) {
    const block = `\nid=${d.id} source=${d.source} ${d.from} -> ${d.to} msgs=${d.user}u/${d.assistant}a size=${d.mb}MB\n  opening: ${d.opening}`;
    if (size + block.length > opts.maxChars) {
      console.log(`\n... remaining sessions omitted by --max-chars budget`);
      break;
    }
    size += block.length;
    console.log(block);
  }
}

function truncate(s, n) {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}...` : oneLine;
}

function timeOf(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function parseSince(value) {
  const now = new Date();
  if (value === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = value.match(/^(\d+)d$/);
  if (days) return now.getTime() - Number(days[1]) * 24 * 60 * 60 * 1000;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00`);
  return null;
}

function compileRegex(pattern, caseSensitive) {
  try {
    return new RegExp(pattern, caseSensitive ? 'u' : 'iu');
  } catch (error) {
    usage(1, `Invalid JavaScript regex: ${error.message}`);
  }
}

function normalizeQueryRegex(pattern, caseSensitive) {
  if (!pattern.startsWith('(?i)')) return pattern;
  if (caseSensitive) usage(1, '--case-sensitive conflicts with the leading (?i) regex modifier');
  const normalized = pattern.slice(4);
  if (!normalized) usage(1, '--regex needs a pattern after the leading (?i) modifier');
  return normalized;
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('Usage: session-grep.mjs --query TEXT [--session ID] [--any] [--candidates] [--regex] [--limit N] [--before N] [--after N] [--role user|assistant|all] [--target-type claude|codex|pi|all ...] [--source claude|codex|pi|all] [--since today|Nd|YYYY-MM-DD] [--sort newest|oldest|file] [--root DIR ...] [--sources-file FILE] [--target-root DIR ...] [--exclude-session ID_PREFIX ...] [--exclude-re REGEX ...] [--max-chars N] [--include-tools] [--case-sensitive] [--json] | --overview | --skim ID | --session ID --at INDEX | --list-roots | --self-test');
  process.exit(code);
}

// ── self-test ───────────────────────────────────────────────────────────────
// The skill carries its own verification: builds a synthetic corpus in a temp dir,
// runs this script against it, and asserts every advertised behavior. Zero deps —
// works wherever the skill is copied. `node session-grep.mjs --self-test`
async function selfTest() {
  const { execFileSync } = await import('node:child_process');
  const self = process.argv[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-grep-selftest-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const line = (role, content, ts) => JSON.stringify({ type: role, timestamp: ts, message: { role, content } }) + '\n';
  const text = (t) => [{ type: 'text', text: t }];

  // Session A: 30 messages; a rare identifier late; a tool_result echo; common words everywhere.
  let a = '';
  for (let i = 0; i < 12; i++) a += line(i % 2 ? 'assistant' : 'user', text(`common sidebar chatter number ${i} about the project`), `2026-06-01T10:${String(i).padStart(2, '0')}:00Z`);
  a += line('assistant', text('the flumoxide bug came from spawnSync returning ENOENT'), '2026-06-01T10:20:00Z');
  a += line('user', [{ type: 'tool_result', content: 'TOOLNOISE flumoxide echoed inside tool output ZEBRAECHO' }], '2026-06-01T10:21:00Z');
  for (let i = 0; i < 12; i++) a += line(i % 2 ? 'assistant' : 'user', text(`more sidebar discussion segment ${i} winding down`), `2026-06-01T11:${String(i).padStart(2, '0')}:00Z`);
  a += line('user', text('final closing message of session alpha'), '2026-06-01T12:00:00Z');
  fs.writeFileSync(path.join(proj, 'aaaa1111.jsonl'), a);
  // Session B: small, distinct.
  const completeShortDecision = `quixotic deployment answered with a --units flag and lookahead syntax note ${'supporting detail '.repeat(24)}FINAL-QUIXOTIC-DECISION`;
  fs.writeFileSync(path.join(proj, 'bbbb2222.jsonl'),
    line('user', text('opening question about quixotic deployment'), '2026-06-05T09:00:00Z') +
    line('assistant', text(completeShortDecision), '2026-06-05T09:01:00Z'));
  // Session H: long lead-in proves a tight window always retains its selected pointer.
  fs.writeFileSync(path.join(proj, 'hhhh5555.jsonl'),
    Array.from({ length: 6 }, (_, i) => line('user', text(`long lead-in ${i} ${'context '.repeat(90)}`), `2026-06-06T09:0${i}:00Z`)).join('') +
    line('assistant', text('ANCHOR-TARGET survives its context budget'), '2026-06-06T09:06:00Z'));
  // Session C: codex format (exercises the adapter registry + path detection).
  fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
  const codexLine = (role, t, ts) => JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role, content: [{ type: 'output_text', text: t }] } }) + '\n';
  fs.writeFileSync(path.join(dir, 'codex', 'rollout-cccc.jsonl'),
    codexLine('assistant', 'zorptastic reply straight from the codex adapter', '2026-06-07T08:00:00Z'));
  // Same Codex format under a root whose path does not reveal the format. This
  // exercises typed source-file overrides as the source of truth for parsing.
  fs.mkdirSync(path.join(dir, 'relocated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'relocated', 'rollout-dddd.jsonl'),
    codexLine('assistant', 'relocatedsource reply from a configured codex root', '2026-06-08T08:00:00Z'));
  fs.mkdirSync(path.join(dir, 'moved'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'moved', 'eeee2222.jsonl'),
    line('assistant', text('movedclaude reply from a configured claude root'), '2026-06-09T08:00:00Z'));
  // Session E: pi format (session header + tree-structured message entries; tool output
  // is its own role:"toolResult" message). Path contains /pi/ to exercise detection.
  fs.mkdirSync(path.join(dir, 'pi'), { recursive: true });
  const piLine = (role, content, ts) => JSON.stringify({ type: 'message', id: 'ab12cd34', parentId: null, timestamp: ts, message: { role, content } }) + '\n';
  fs.writeFileSync(path.join(dir, 'pi', '2026-06-10T08-00-00_ffff3333.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'ffff3333', timestamp: '2026-06-10T08:00:00Z', cwd: '/tmp/proj' }) + '\n' +
    piLine('user', 'plumbuscal question asked in the pi harness', '2026-06-10T08:00:01Z') +
    piLine('assistant', [{ type: 'text', text: 'plumbuscal answered straight from the pi adapter' }], '2026-06-10T08:00:02Z') +
    JSON.stringify({ type: 'message', id: 'ef56ab78', parentId: 'ab12cd34', timestamp: '2026-06-10T08:00:03Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'PINOISE tool output from pi' }], isError: false } }) + '\n' +
    piLine('custom', [{ type: 'text', text: 'PICUSTOM non-conversation entry' }], '2026-06-10T08:00:04Z'));
  // Same pi format under a root whose path does not reveal the format (config routing).
  fs.mkdirSync(path.join(dir, 'relocated-pi'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'relocated-pi', '2026-06-11T08-00-00_gggg4444.jsonl'),
    piLine('assistant', [{ type: 'text', text: 'relocatedpi reply from a configured pi root' }], '2026-06-11T08:00:00Z'));

  const runRaw = (args, env = {}) => execFileSync(process.execPath, [self, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const run = (args) => runRaw([...args, '--root', dir]);
  let n = 0;
  const failures = [];
  const check = (name, cond) => { n++; if (!cond) failures.push(name); };

  try {
    // literal + context + truthful shown count
    const lit = JSON.parse(run(['--query', 'flumoxide', '--json']));
    check('literal finds text block', lit.matches.some((m) => m.match.text.includes('spawnSync')));
    check('shown equals matches length', lit.shown === lit.matches.length);
    check('tool_result excluded by default', !lit.matches.some((m) => m.match.text.includes('TOOLNOISE')));
    const withTools = JSON.parse(run(['--query', 'ZEBRAECHO', '--json', '--include-tools']));
    check('--include-tools matches tool output', withTools.totalMatches === 1);
    const withoutTools = JSON.parse(run(['--query', 'ZEBRAECHO', '--json']));
    check('tool-only needle invisible by default', withoutTools.totalMatches === 0);

    // --any: rarity ranking + dedupe
    const any = JSON.parse(run(['--query', 'sidebar flumoxide sidebar', '--any', '--json']));
    check('any dedupes words', Object.keys(any.wordHits).length === 2);
    check('rare word ranks first', any.matches[0].matchedWords.includes('flumoxide'));
    check('word df counted', any.wordHits.sidebar > any.wordHits.flumoxide);
    const pipeAny = JSON.parse(run(['--query', 'sidebar|flumoxide|absentword', '--any', '--json']));
    check('--any treats pipe separators as term delimiters',
      pipeAny.totalMatches > 0 &&
      Object.keys(pipeAny.wordHits).join(',') === 'sidebar,flumoxide,absentword');
    const completePreview = run(['--query', 'quixotic', '--before', '0', '--after', '0', '--limit', '2', '--max-chars', '4000']);
    check('query preserves a complete short message when it fits the output aperture',
      completePreview.includes('FINAL-QUIXOTIC-DECISION'));
    const leadingDash = JSON.parse(run(['--query', '--units', '--json']));
    check('literal query beginning with dashes reaches ripgrep as a pattern', leadingDash.totalMatches === 1);
    const candidates = JSON.parse(run(['--query', 'deployment sidebar', '--any', '--candidates', '--limit', '2', '--json']));
    check('--candidates groups before limit', candidates.totalCandidateSessions === 2 && candidates.candidates.length === 2);
    check('--candidates retains distinct sessions', new Set(candidates.candidates.map((c) => c.id)).size === 2);
    check('--candidates reports full hit count', candidates.candidates.find((c) => c.id === 'aaaa1111').hitCount > 2);

    // budget enforcement + omission notice
    const tiny = run(['--query', 'sidebar', '--limit', '30', '--max-chars', '600']);
    check('budget respected (<=600+slack)', tiny.length <= 900);
    check('omission notice present', tiny.includes('omitted by the 600-char output budget'));
    const tinyShown = Number(tiny.match(/shown=(\d+)/)[1]);
    check('header shown = emitted blocks', (tiny.match(/\n\[\d+\]/g) || []).length === tinyShown);

    // zero-hit hint
    const miss = run(['--query', 'totally absent phrase here']);
    check('multi-word miss hints --any', miss.includes('retry with --any'));

    // regex incl. JS-only syntax (lookahead) falling back past rg
    const la = JSON.parse(run(['--regex', '--query', 'quixotic(?= deployment)', '--json']));
    check('JS-only regex still matches via fallback', la.totalMatches === 2);
    const inlineCase = JSON.parse(run(['--regex', '--query', '(?i)QUIXOTIC', '--json']));
    check('common leading (?i) regex modifier is accepted', inlineCase.totalMatches === 2);

    // overview + spine
    const ov = run(['--overview']);
    check('overview lists both sessions', ov.includes('aaaa1111') && ov.includes('bbbb2222'));
    const ovCodex = run(['--overview', '--target-type', 'codex']);
    check('overview honors --target-type', ovCodex.includes('rollout-cccc') && !ovCodex.includes('aaaa1111') && !ovCodex.includes('bbbb2222'));
    const ovRecent = run(['--overview', '--since', '2026-06-06']);
    check('overview honors --since', ovRecent.includes('rollout-cccc') && !ovRecent.includes('aaaa1111') && !ovRecent.includes('bbbb2222'));
    const spine = run(['--skim', 'aaaa1111', '--max-chars', '900']);
    check('skim rendered output stays within budget', spine.length <= 900);
    check('skim keeps head', spine.includes('number 0'));
    check('skim keeps tail', spine.includes('session alpha'));
    const scopedQuery = JSON.parse(run(['--query', 'sidebar', '--session', 'aaaa1111', '--json']));
    check('query can scope to one stable session', scopedQuery.session === 'aaaa1111' && scopedQuery.matches.every((match) => match.id === 'aaaa1111'));
    const mixedModes = spawnSync(process.execPath, [self, '--query', 'sidebar', '--session', 'aaaa1111', '--at', '0', '--root', dir], { encoding: 'utf8' });
    check('ambiguous query + window modes fail closed', mixedModes.status === 1 && mixedModes.stderr.includes('choose exactly one mode'));

    // role filter still works
    const role = JSON.parse(run(['--query', 'sidebar', '--role', 'user', '--json']));
    check('role filter', role.matches.every((m) => m.match.role === 'user'));

    // adapter registry: codex format parsed, source detected from path, --target-type filters
    const cx = JSON.parse(run(['--query', 'zorptastic', '--json']));
    check('codex adapter parses', cx.totalMatches === 1 && cx.matches[0].source === 'codex');
    const cxOnly = JSON.parse(run(['--query', 'zorptastic', '--target-type', 'claude', '--json']));
    check('--target-type filters by adapter', cxOnly.totalMatches === 0);
    const cxLegacy = JSON.parse(run(['--query', 'zorptastic', '--source', 'claude', '--json']));
    check('--source remains a compatibility alias for --target-type', cxLegacy.totalMatches === 0);

    // pi adapter: format parsed, source detected from path, toolResult gated by --include-tools
    const pi = JSON.parse(run(['--query', 'plumbuscal', '--json']));
    check('pi adapter parses user+assistant', pi.totalMatches === 2 && pi.matches.every((m) => m.source === 'pi'));
    const piOnly = JSON.parse(run(['--query', 'zorptastic', '--target-type', 'pi', '--json']));
    check('--target-type pi filters by adapter', piOnly.totalMatches === 0);
    const piNoise = JSON.parse(run(['--query', 'PINOISE', '--json']));
    check('pi toolResult excluded by default', piNoise.totalMatches === 0);
    const piTools = JSON.parse(run(['--query', 'PINOISE', '--json', '--include-tools']));
    check('pi toolResult matches with --include-tools', piTools.totalMatches === 1 && piTools.matches[0].match.role === 'user');
    const piCustom = JSON.parse(run(['--query', 'PICUSTOM', '--json', '--include-tools']));
    check('pi non-conversation roles skipped', piCustom.totalMatches === 0);

    // --exclude-re: path-based exclusion holds across search, browse, and window modes
    const excluded = JSON.parse(run(['--query', 'sidebar', '--json', '--exclude-re', 'aaaa1111']));
    check('--exclude-re removes matching paths', excluded.totalMatches === 0);
    const kept = JSON.parse(run(['--query', 'quixotic', '--json', '--exclude-re', 'aaaa1111']));
    check('--exclude-re keeps non-matching paths', kept.totalMatches === 2);
    const ovExcluded = run(['--overview', '--exclude-re', 'aaaa1111', '--exclude-re', 'bbbb2222']);
    check('--exclude-re repeatable + honored by --overview', !ovExcluded.includes('aaaa1111') && !ovExcluded.includes('bbbb2222') && ovExcluded.includes('rollout-cccc'));
    const winExcluded = spawnSync(process.execPath, [self, '--session', 'aaaa1111', '--at', '0', '--root', dir, '--exclude-re', 'aaaa1111'], { encoding: 'utf8' });
    check('--exclude-re honored by --session/--at', winExcluded.status === 1 && !winExcluded.stdout.includes('flumoxide'));
    const badRe = spawnSync(process.execPath, [self, '--query', 'x', '--root', dir, '--exclude-re', '('], { encoding: 'utf8' });
    check('invalid --exclude-re rejected', badRe.status === 1 && badRe.stderr.includes('--exclude-re'));
    const excludedSession = JSON.parse(run(['--query', 'sidebar', '--json', '--exclude-session', 'aaaa']));
    check('--exclude-session removes canonical session id', excludedSession.totalMatches === 0 && excludedSession.excludedSessions[0] === 'aaaa');
    const sessionWindowExcluded = spawnSync(process.execPath, [self, '--session', 'aaaa1111', '--at', '0', '--root', dir, '--exclude-session', 'aaaa'], { encoding: 'utf8' });
    check('--exclude-session applies to direct modes when explicitly passed', sessionWindowExcluded.status === 1);

    const sourcesFile = path.join(dir, 'session_sources.json');
    fs.writeFileSync(sourcesFile, JSON.stringify([
      { type: 'codex', root: path.join(dir, 'relocated') },
      { type: 'claude', root: path.join(dir, 'moved') },
      { type: 'pi', root: path.join(dir, 'relocated-pi') },
    ]));
    const configured = JSON.parse(runRaw(['--query', 'relocatedsource', '--json'], { SESSION_GREP_SOURCES_FILE: sourcesFile }));
    check('session_sources type routes codex parser', configured.totalMatches === 1 && configured.matches[0].source === 'codex');
    const configuredViaFlag = JSON.parse(runRaw(['--query', 'relocatedsource', '--json', '--sources-file', sourcesFile]));
    check('--sources-file type routes codex parser', configuredViaFlag.totalMatches === 1 && configuredViaFlag.matches[0].source === 'codex');
    const envOnlySourcesFile = path.join(dir, 'env_only_sources.json');
    fs.writeFileSync(envOnlySourcesFile, JSON.stringify([{ type: 'claude', root: path.join(dir, 'moved') }]));
    const flagWins = JSON.parse(runRaw(['--query', 'relocatedsource', '--json', '--sources-file', sourcesFile], { SESSION_GREP_SOURCES_FILE: envOnlySourcesFile }));
    check('--sources-file wins over SESSION_GREP_SOURCES_FILE', flagWins.totalMatches === 1 && flagWins.matches[0].source === 'codex');
    const targetedPi = JSON.parse(runRaw(['--query', 'relocatedpi', '--json', '--sources-file', sourcesFile, '--target-root', path.join(dir, 'relocated-pi')]));
    check('--target-root narrows to configured root and keeps parser mapping', targetedPi.totalMatches === 1 && targetedPi.matches[0].source === 'pi');
    const targetedMiss = JSON.parse(runRaw(['--query', 'relocatedsource', '--json', '--sources-file', sourcesFile, '--target-root', path.join(dir, 'relocated-pi')]));
    check('--target-root excludes other configured roots', targetedMiss.totalMatches === 0);
    const missingExplicit = spawnSync(process.execPath, [self, '--list-roots', '--sources-file', path.join(dir, 'missing_sources.json')], { encoding: 'utf8' });
    check('missing explicit --sources-file fails closed', missingExplicit.status === 1 && missingExplicit.stderr.includes('--sources-file') && !missingExplicit.stdout.includes('origin='));
    const rootAndSources = spawnSync(process.execPath, [self, '--query', 'x', '--root', dir, '--sources-file', sourcesFile], { encoding: 'utf8' });
    check('--root and --sources-file cannot be combined silently', rootAndSources.status === 1 && rootAndSources.stderr.includes('cannot be combined'));
    const configuredClaude = JSON.parse(runRaw(['--query', 'movedclaude', '--json'], { SESSION_GREP_SOURCES_FILE: sourcesFile }));
    check('session_sources type routes claude parser', configuredClaude.totalMatches === 1 && configuredClaude.matches[0].source === 'claude');
    const configuredPi = JSON.parse(runRaw(['--query', 'relocatedpi', '--json'], { SESSION_GREP_SOURCES_FILE: sourcesFile }));
    check('session_sources type routes pi parser', configuredPi.totalMatches === 1 && configuredPi.matches[0].source === 'pi');
    const listed = runRaw(['--list-roots'], { SESSION_GREP_SOURCES_FILE: sourcesFile });
    check('--list-roots shows configured root', listed.includes(`config=${sourcesFile}`) && listed.includes(path.join(dir, 'relocated')));
    // A malformed env config falls back for compatibility, but must be flagged.
    const badFile = path.join(dir, 'bad_sources.json');
    fs.writeFileSync(badFile, '{ "disable": ["codex"], not-valid ]');
    const bad = spawnSync(process.execPath, [self, '--list-roots'], { encoding: 'utf8', env: { ...process.env, SESSION_GREP_SOURCES_FILE: badFile } });
    check('malformed config warns on stderr', bad.stderr.includes('is not valid JSON'));
    check('malformed config flagged in --list-roots', bad.stdout.includes('config_error=true'));

    // pointer drill-in: consume a hit's id+idx via --session/--at
    const hit = JSON.parse(run(['--query', 'flumoxide', '--json'])).matches[0];
    const win = run(['--session', hit.id.slice(0, 6), '--at', String(hit.index)]);
    check('window centers on the hit', win.includes(`[${hit.index}]*`) && win.includes('flumoxide'));
    check('window includes neighbors', win.includes(`[${hit.index - 1}] `) && win.includes(`[${hit.index + 1}] `));
    const tightWin = run(['--session', 'hhhh5555', '--at', '6', '--before', '5', '--after', '0', '--max-chars', '500']);
    check('tight window always retains selected target', tightWin.includes('[6]*') && tightWin.includes('ANCHOR-TARGET'));
  } catch (error) {
    failures.push(`crashed: ${error.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`self-test: ${failures.length}/${n} FAILED:\n  - ${failures.join('\n  - ')}`);
    return 1;
  }
  console.log(`self-test: ok — ${n} assertions passed`);
  return 0;
}

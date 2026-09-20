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
const DAY_MS = 24 * 60 * 60 * 1000;
// Module constants used by top-level code live here: a const beside its function sits
// in the temporal dead zone when argument handling runs.
const PREFIX_SEED = 2166136261;
const opts = { limit: 20, before: 1, after: 1, role: 'all', sort: 'newest', json: false, regex: false, roots: [], targetTypes: [], targetRoots: [], excludeRe: [], excludeSessions: [], maxChars: 8000 };
// [flag, argument or null, description, apply] — the parser and --help share it.
const FLAGS = [
  ['--query', 'TEXT', 'literal query, or a JavaScript regex with --regex; the text may itself begin with dashes', (v) => { opts.query = v; }],
  ['--any', null, 'match ANY query word (whitespace or | delimit terms); BM25-ranked, per-word hit counts reported', () => { opts.any = true; }],
  ['--candidates', null, 'group hits by session before --limit/--max-chars; one best pointer per session', () => { opts.candidates = true; }],
  ['--regex', null, 'treat --query as a JavaScript regex; case-insensitive unless --case-sensitive', () => { opts.regex = true; }],
  ['--session', 'ID_PREFIX', 'scope a query to one session; with --at, open the messages around one index', (v) => { opts.session = v; }],
  ['--at', 'INDEX', 'with --session: the message index to open, from a hit\'s idx= (±5 messages by default)', (v) => { opts.at = Number(v); }],
  ['--focus', 'TEXT', 'with --session/--at: centre the opened message\'s preview on this text instead of its start', (v) => { opts.focus = v; }],
  ['--overview', null, 'no query: one compact digest per session', () => { opts.overview = true; }],
  ['--skim', 'ID_PREFIX', 'no query: one session\'s conversation, head/tail kept, middle sampled', (v) => { opts.skim = v; }],
  ['--list-roots', null, 'print the configured source/root map and whether each root exists', () => { opts.listRoots = true; }],
  ['--limit', 'N', 'max matching messages (sessions with --candidates), default 20', (v) => { opts.limit = Number(v); }],
  ['--before', 'N', 'messages before each hit, default 1 (5 in --session/--at)', (v) => { opts.before = Number(v); opts.beforeSet = true; }],
  ['--after', 'N', 'messages after each hit, default 1 (5 in --session/--at)', (v) => { opts.after = Number(v); opts.afterSet = true; }],
  ['--role', 'user|assistant|all', 'filter matching messages, default all', (v) => { opts.role = v; }],
  ['--since', 'today|Nd|YYYY-MM-DD', 'only messages at or after this time', (v) => { opts.since = v; }],
  ['--until', 'today|Nd|YYYY-MM-DD', 'upper bound on message time, inclusive of the day or period named', (v) => { opts.until = v; }],
  ['--sort', 'newest|oldest|file', 'output order, default newest (--any ranks by score first)', (v) => { opts.sort = v; }],
  ['--target-type', 'claude|codex|pi|all', 'narrow to parser/source types (repeatable)', (v) => { opts.targetTypes.push(v); }],
  ['--source', 'claude|codex|pi|all', 'alias for --target-type', (v) => { opts.targetTypes.push(v); }],
  ['--root', 'DIR', 'search this directory of *.jsonl transcripts instead of the defaults; untyped, format auto-detected (repeatable)', (v) => { opts.roots.push(v); }],
  ['--sources-file', 'FILE', 'JSON array of typed { type, root } sources, replacing the defaults', (v) => { opts.sourcesFile = v; }],
  ['--target-root', 'DIR', 'narrow configured sources to this root or a subdirectory of one, keeping its type (repeatable)', (v) => { opts.targetRoots.push(v); }],
  ['--exclude-session', 'ID_PREFIX', 'exclude a session by canonical id (repeatable)', (v) => { opts.excludeSessions.push(v); }],
  ['--exclude-re', 'REGEX', 'exclude session files whose path matches this JavaScript regex; every mode (repeatable)', (v) => { opts.excludeRe.push(v); }],
  ['--max-chars', 'BYTES', 'output budget, default 8000, minimum 500; a hard ceiling on rendered output', (v) => { opts.maxChars = Number(v); opts.maxCharsSet = true; }],
  ['--max-tokens', 'N', 'the same budget in tokens (4 bytes ≈ 1 token)', (v) => { opts.maxChars = Number(v) * 4; opts.maxCharsSet = true; }],
  ['--include-tools', null, 'also match inside tool calls and results (excluded by default)', () => { opts.includeTools = true; }],
  ['--include-skill-bodies', null, 'also match inside injected slash-command skill bodies (excluded by default)', () => { opts.includeSkillBodies = true; }],
  ['--case-sensitive', null, 'exact case match', () => { opts.caseSensitive = true; }],
  ['--json', null, 'machine-readable output; same budget and truncation as text', () => { opts.json = true; }],
  ['--self-test', null, 'verify this copy against a built-in synthetic corpus', () => { opts.selfTest = true; }],
  ['--help', null, 'print this help', () => usage(0)],
];
const FLAG_INDEX = new Map(FLAGS.map((f) => [f[0], f]));
for (let i = 0; i < args.length; i++) {
  const a = args[i] === '-h' ? '--help' : args[i];
  const flag = FLAG_INDEX.get(a);
  if (!flag) usage(1, `Unknown arg: ${a}`);
  const [, arg, , apply] = flag;
  if (!arg) apply();
  else if (i + 1 >= args.length) usage(1, `${a} requires ${arg}`);
  else apply(args[++i]);
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
if (!Number.isFinite(opts.maxChars) || opts.maxChars < 500) usage(1, '--max-chars must be >= 500 (--max-tokens >= 125)');
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
const untilTime = opts.until ? parseUntil(opts.until) : null;
if (opts.until && untilTime == null) usage(1, '--until must be today, Nd, or YYYY-MM-DD');
if (sinceTime != null && untilTime != null && untilTime <= sinceTime) usage(1, '--until must be later than --since');
if (opts.focus != null && !(opts.session && opts.at != null)) usage(1, '--focus requires --session ID_PREFIX --at INDEX');
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

// The output budget is denominated in BYTES (≈ 4 bytes per token): CJK, emoji, and
// code cost what they actually cost the caller's context, and every rendered line —
// header, word_hits, hint, omission notices — is charged, so output never exceeds it.
function bytes(s) {
  return Buffer.byteLength(s);
}

// --any: multi-word phrases rarely occur verbatim in transcripts, so match ANY word
// and rank with BM25 over per-run df (rarity, saturated TF, length). Low-signal
// words are dropped from the word set so common glue doesn't dominate the ranking.
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
  const wanted = opts.targetRoots.map((root) => path.resolve(expandHome(root)));
  const narrowed = [];
  const seen = new Set();
  for (const w of wanted) {
    let best = null;
    let bestLen = -1;
    for (const entry of sourceMap.roots) {
      const r = path.resolve(entry.root);
      if (w === r || w.startsWith(r + path.sep)) {
        if (r.length > bestLen) { best = entry; bestLen = r.length; }
      }
    }
    if (best) {
      const key = `${best.type}\0${w}`;
      if (!seen.has(key)) { seen.add(key); narrowed.push({ type: best.type, root: w }); }
    }
  }
  if (!narrowed.length) {
    usage(1, `--target-root did not match any configured roots. Known roots: ${sourceMap.roots.map((entry) => entry.root).join(', ')}`);
  }
  sourceMap = { ...sourceMap, roots: narrowed };
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
  // The header is budgeted too: a deep path must not bust a small budget on line one.
  const head = truncate(`window id=${sessionId(file)} messages ${from}..${to} of ${messages.length} path=${file}`, opts.maxChars - 80);
  console.log(head);
  const available = opts.maxChars - bytes(head) - 1 - 80; // 80: reserve for the truncation notice
  const lineFor = (i, cap) => {
    const m = messages[i];
    const preview = i === opts.at && opts.focus != null ? truncateAround(m.text, cap, opts.focus) : truncate(m.text, cap);
    return `[${i}]${i === opts.at ? '*' : ' '} ${m.role}${m.timestamp ? ' ' + String(m.timestamp).slice(0, 16) : ''}: ${preview}`;
  };
  // Reserve the selected message first, then spend what remains on the nearest context.
  // Selection happens before chronological rendering, so a tight budget can never consume
  // five lead-in previews and throw away the stable pointer's actual evidence.
  const contextReserve = Math.min(2_000, Math.floor(opts.maxChars * 0.35));
  const targetCap = Math.max(80, available - contextReserve);
  const selected = new Map([[opts.at, lineFor(opts.at, targetCap)]]);
  let size = bytes(selected.get(opts.at)) + 1;
  for (let distance = 1; selected.size < to - from + 1; distance++) {
    const nearby = [opts.at - distance, opts.at + distance]
      .filter((index) => index >= from && index <= to);
    if (!nearby.length) break;
    for (const index of nearby) {
      const line = lineFor(index, 300);
      if (size + bytes(line) + 1 <= available) {
        selected.set(index, line);
        size += bytes(line) + 1;
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
// rg enumerates files in nondeterministic (parallel-walk) order; sort so identical
// invocations rank ties identically.
files = files.filter((f) => !isExcluded(f) && !isExcludedSession(f)).sort();
// --target-type narrows the searched scope, so the prefilter list is narrowed before
// the header is computed: raw_files_with_hits must describe files actually searched,
// not files counted then skipped in the match loop.
if (targetTypes.size) files = files.filter((f) => targetTypes.has(sourceOf(f)));
if (sinceTime != null) files = filesWrittenSince(files, sinceTime);
const matches = [];
const q = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
// Proactive query-shape signal (#24): a multi-word literal almost never occurs
// verbatim — surfaced in the header on every result, not just the zero-hit path.
// Matching semantics are unchanged; this only advises the --any retry earlier.
const literalMultiword = !opts.any && !opts.regex && opts.query.trim().split(/\s+/).length > 1;
// --any rarity stats: document frequency per word across scanned messages. Rare words
// are the signal; the ranking weights them (IDF) and the output reports the counts so
// the caller learns which of its words are low-signal. Counted AFTER the --role/--since
// filters so word_hits describes the population the caller actually sees.
const wordDf = anyWords ? Object.fromEntries(anyWords.map((w) => [w, 0])) : null;
let messagesScanned = 0;
let toolsExcluded = 0;
let skillBodiesExcluded = 0;
let textLenSum = 0;
const BM25_K1 = 1.4;
const BM25_B = 0.75;

for (const file of files) {
  const source = sourceOf(file);
  if (targetTypes.size && !targetTypes.has(source)) continue;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const records = parseRecords(raw);
  const messages = messagesFrom(records, source);
  let fileMtime = null; // timestamp fallback, one stat per file not per message
  const mtime = () => (fileMtime ??= fs.statSync(file).mtimeMs);
  // A resume replays its ancestor's messages, so the evidence that two sessions are
  // copies is the prefix they share before the hit. Accumulated as we walk the file.
  let replayedPrefix = PREFIX_SEED;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const replayedPrefixHere = replayedPrefix;
    replayedPrefix = extendPrefix(replayedPrefix, msg.text);
    if (opts.role !== 'all' && msg.role !== opts.role) continue;
    let time = null;
    if (sinceTime != null || untilTime != null) {
      time = timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? mtime();
      if (sinceTime != null && time < sinceTime) continue;
      if (untilTime != null && time >= untilTime) continue;
    }
    messagesScanned++;
    const dl = Math.max(1, msg.text.length);
    textLenSum += dl;
    const haystack = opts.caseSensitive ? msg.text : msg.text.toLowerCase();
    let hitWords = null;
    let termFreq = null;
    if (anyWords) {
      hitWords = anyWords.filter((w) => haystack.includes(w));
      for (const w of hitWords) wordDf[w]++;
      if (!hitWords.length) continue;
      termFreq = Object.fromEntries(hitWords.map((w) => [w, countOccurrences(haystack, w)]));
    } else if (opts.regex ? !queryRegex.test(msg.text) : !haystack.includes(q)) continue;
    time ??= timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? mtime();
    matches.push({
      source,
      id: sessionId(file),
      path: file,
      index: i,
      timestamp: msg.timestamp,
      time,
      dl,
      replayedPrefix: replayedPrefixHere,
      ...(anyWords ? { matchedWords: hitWords, termFreq } : {}),
      before: messages.slice(Math.max(0, i - opts.before), i),
      match: msg,
      after: messages.slice(i + 1, i + 1 + opts.after),
    });
  }
}

// With --any, rank by BM25 over the per-run df table: IDF plus term-frequency
// saturation and length normalization, so a short message about a rare term beats a
// long one that happens to mention it. Recency breaks remaining ties (newest unless
// --sort oldest), then id/index so equal-time hits order deterministically.
const stable = (a, b) => a.id.localeCompare(b.id) || a.index - b.index;
const recency = (a, b) => (opts.sort === 'oldest' ? a.time - b.time : b.time - a.time);
const byRank = (a, b) => {
  if (anyWords) return (b.score ?? 0) - (a.score ?? 0) || recency(a, b) || stable(a, b);
  if (opts.sort === 'oldest') return a.time - b.time || stable(a, b);
  if (opts.sort === 'newest') return b.time - a.time || stable(a, b);
  return 0;
};
if (anyWords) {
  const avgdl = textLenSum / Math.max(1, messagesScanned);
  // Lucene-style positive IDF: a term that hits every scanned message still has
  // weight, so length normalization can separate a short on-topic hit from a long
  // mention. log((N+1)/(df+1)) would be 0 in that case and ranking would collapse
  // to recency.
  const idf = (w) => Math.log(1 + (messagesScanned - wordDf[w] + 0.5) / (wordDf[w] + 0.5));
  const tfWeight = (tf, dl) => {
    const norm = BM25_K1 * (1 - BM25_B + BM25_B * (dl / Math.max(avgdl, 1)));
    return (tf * (BM25_K1 + 1)) / (tf + norm);
  };
  for (const m of matches) {
    m.score = round3(m.matchedWords.reduce((t, w) => t + idf(w) * tfWeight(m.termFreq[w] || 1, m.dl), 0));
  }
}
matches.sort(byRank);
// Fork/resume transcripts replay the same message under new session ids. Collapse
// identical match text onto the earliest copy so the budget buys distinct evidence.
const collapsed = collapseForks(matches, byRank);
const candidates = opts.candidates ? groupCandidates(collapsed) : null;
const rankedEntries = candidates ?? collapsed;
const limited = rankedEntries.slice(0, opts.limit);
const filesWithMatches = new Set(matches.map((m) => m.path)).size;

const resultIsThin = rankedEntries.length < opts.limit;
if (resultIsThin && (!opts.includeTools || !opts.includeSkillBodies)) recountExcludedMatches(files);

// Zero hits should steer the next query, not dead-end the agent: multi-word literal
// phrases almost never occur verbatim in transcripts — say so and point at --any.
// When matches hid behind content exclusions, name that lever too (#22): a zero-hit
// result otherwise reads as "not in the corpus" when the fix is a flag, not a rephrase.
const excludedPointer = [
  toolsExcluded > 0 && !opts.includeTools
    ? `${toolsExcluded} more inside tool blocks — add --include-tools`
    : null,
  skillBodiesExcluded > 0 && !opts.includeSkillBodies
    ? `${skillBodiesExcluded} more inside skill bodies — add --include-skill-bodies`
    : null,
].filter(Boolean).join('; ');
const hintBase = !limited.length
  ? (literalMultiword
      ? 'no hits: multi-word phrases rarely occur verbatim in transcripts — retry with --any (matches any word, ranked by rarity and length), or grep ONE rare term (an identifier, error string, or filename)'
      : opts.any
        ? 'no hits for any query word: try different, rarer words (identifiers, error strings, filenames), or loosen --since/--role filters'
        : 'no hits: try a rarer single term, or --any with several candidate words')
  : null;
const hint = hintBase ? (excludedPointer ? `${hintBase}; ${excludedPointer}` : hintBase) : null;

// Per-word hit counts teach the caller which of its words are low-signal: a word
// matching thousands of messages contributes nothing — drop it next query.
const wordStats = anyWords
  ? anyWords.map((w) => `${w}=${wordDf[w]}`).join(' ')
  : null;

// Output is budgeted (--max-chars bytes, default 8k): a bad query can't flood the
// caller's context. The REAL header, word_hits, hint, and omission lines are charged
// against the budget (not a fixed allowance), then hits are selected in rank order.
// Two invariants:
//  - Monotone: when several hits compete, each is capped to one-third of the budget
//    (and otherwise a fair share), so raising --max-chars can only extend the emitted
//    set or lengthen previews — never reshuffle or evict an earlier hit.
//  - Evidence outranks metadata: whenever the fixed lines can't fit (zero-hit df
//    tables included) the word_hits table is dropped, and before returning shown=0
//    with matches present the top hit is hard-shrunk (text first, path last).
const OMIT = (n) => `... ${n} more matching ${opts.candidates ? 'sessions' : 'messages'} omitted by the ${opts.maxChars}-byte output budget — ${scopedSessionFile
  ? 'stay in this --session scope; reduce --before/--after, use --sort oldest for chronology, or raise --max-chars'
  : `narrow with --role/--since${opts.any ? '/rarer words' : ''}, or raise --max-chars`}`;
const queryEcho = truncate(opts.query, 120); // a 2k-char query must not eat the budget echoing itself

// Adaptive previews: with few hits and a roomy budget, spend the aperture on fuller
// match text instead of leaving it unspent (a complete short decision should never
// be clipped at 300 when the budget could carry all of it). Caps are bytes.
const CONTEXT_PREVIEW_CHARS = 180;
const MIN_MATCH_PREVIEW_CHARS = 300;
const ENTRY_OVERHEAD_CHARS = 220;
const HEADER_ALLOWANCE_ESTIMATE = 300;
const competing = Math.max(1, limited.length);
const fairShare = Math.floor((opts.maxChars - HEADER_ALLOWANCE_ESTIMATE) / competing);
const maxHitShare = competing > 1
  ? Math.max(MIN_MATCH_PREVIEW_CHARS, Math.floor(opts.maxChars / 3))
  : Math.max(MIN_MATCH_PREVIEW_CHARS, opts.maxChars - HEADER_ALLOWANCE_ESTIMATE);
const entryShare = Math.min(maxHitShare, Math.max(MIN_MATCH_PREVIEW_CHARS, fairShare));
const matchPreviewChars = (entry) => Math.max(
  MIN_MATCH_PREVIEW_CHARS,
  entryShare - ENTRY_OVERHEAD_CHARS -
    (opts.candidates ? 0 : entry.before.length + entry.after.length) * (CONTEXT_PREVIEW_CHARS + 20),
);
const matchNeedle = (entry) => {
  if (anyWords && entry.matchedWords?.length) {
    const pool = entry.bestMatchedWords ?? entry.matchedWords;
    return pool.reduce((best, w) => (wordDf[w] <= wordDf[best] ? w : best));
  }
  if (opts.regex && queryRegex) {
    const found = queryRegex.exec(entry.match.text);
    queryRegex.lastIndex = 0;
    return found?.[0] ?? queryPattern;
  }
  return opts.query;
};
const previewMatch = (entry, room = matchPreviewChars(entry)) => truncateAround(entry.match.text, room, matchNeedle(entry));

function selectWithinBudget(renderLen, budget) {
  const emitted = [];
  let size = 0;
  for (const m of limited) {
    const len = renderLen(m);
    if (size + len > budget) break;
    size += len;
    emitted.push(m);
  }
  return emitted;
}

// Last resort when not even the top hit fits whole: shed context, then shrink the
// match text, then squeeze the path (the id/idx pointer still resolves it).
function forceOneHit(renderLen, budget) {
  const m = limited[0];
  for (const pathMax of [Infinity, 80]) {
    for (const room of [300, 150, 75, 40]) {
      const cand = {
        ...m,
        before: [],
        after: [],
        path: pathMax === Infinity ? m.path : truncate(m.path, pathMax),
        match: { ...m.match, text: previewMatch(m, room) },
      };
      if (renderLen(cand) <= budget) return [cand];
    }
  }
  return [];
}

if (opts.json) {
  const slim = (msg, chars) => ({ role: msg.role, text: truncate(msg.text, chars), timestamp: msg.timestamp });
  const forks = (m) => (m.forkCopies ? { forkCopies: m.forkCopies } : {});
  const toEntry = opts.candidates
    ? (m) => ({ source: m.source, id: m.id, index: m.index, timestamp: m.timestamp, hitCount: m.hitCount, ...forks(m), ...(anyWords ? { matchedWords: m.matchedWords, bestMatchedWords: m.bestMatchedWords, score: m.score } : {}), path: m.path, match: { role: m.match.role, text: previewMatch(m), timestamp: m.match.timestamp } })
    : (m) => ({ source: m.source, id: m.id, index: m.index, timestamp: m.timestamp, ...forks(m), ...(anyWords ? { matchedWords: m.matchedWords, score: m.score } : {}), path: m.path, before: m.before.map((message) => slim(message, CONTEXT_PREVIEW_CHARS)), match: { role: m.match.role, text: previewMatch(m), timestamp: m.match.timestamp }, after: m.after.map((message) => slim(message, CONTEXT_PREVIEW_CHARS)) });
  const entryLen = (m) => bytes(JSON.stringify(toEntry(m))) + 1;
  let withStats = !!anyWords;
  // Worst-case envelope (max shown/omitted digits, omission note included, trailing
  // newline) so the real output can only come in at or under the charged size.
  const excludedEnvelope = (toolsExcluded > 0 && !opts.includeTools) || (skillBodiesExcluded > 0 && !opts.includeSkillBodies)
    ? { excluded: { ...(toolsExcluded > 0 && !opts.includeTools ? { tools: toolsExcluded } : {}), ...(skillBodiesExcluded > 0 && !opts.includeSkillBodies ? { skillBodies: skillBodiesExcluded } : {}) } }
    : {};
  const envelope = (entriesArr, shown, omitted) => ({ query: queryEcho, ...(scopedSessionFile ? { session: sessionId(scopedSessionFile) } : {}), regex: opts.regex, any: !!opts.any, ...(literalMultiword ? { literalMultiword: true } : {}), ...(withStats ? { wordHits: wordDf, messagesScanned } : {}), rawFilesWithHits: files.length, filesWithMatches, totalMatches: matches.length, ...excludedEnvelope, ...(candidates ? { totalCandidateSessions: candidates.length } : {}), ...(opts.excludeSessions.length ? { excludedSessions: opts.excludeSessions } : {}), shown, ...(omitted ? { omittedByBudget: omitted, note: OMIT(omitted) } : {}), ...(hint ? { hint } : {}), [opts.candidates ? 'candidates' : 'matches']: entriesArr });
  const room = (withOmit) => opts.maxChars - bytes(JSON.stringify(envelope([], limited.length, withOmit ? limited.length : 0))) - 1;
  // A df table that can't fit is dropped even with zero hits — the ceiling binds always.
  if (withStats && room(false) < 0) withStats = false;
  // Two-phase: the omission note only prints when hits are omitted, so charge its
  // reserve only when selection actually falls short of the full list.
  let emitted = selectWithinBudget(entryLen, room(false));
  if (emitted.length < limited.length) {
    emitted = selectWithinBudget(entryLen, room(true));
    if (!emitted.length && withStats) {
      withStats = false;
      emitted = selectWithinBudget(entryLen, room(true));
    }
    // Emitting the sole hit means nothing is omitted, so no note reserve applies then.
    if (!emitted.length) emitted = forceOneHit(entryLen, room(limited.length > 1));
  }
  console.log(JSON.stringify(envelope(emitted.map(toEntry), emitted.length, limited.length - emitted.length)));
} else {
  const forkNote = (m) => (m.forkCopies ? ` +${m.forkCopies} forked copies` : '');
  const renderLines = opts.candidates
    ? (m) => [
        `${m.source} id=${m.id} best_idx=${m.index} hits=${m.hitCount} ts=${m.timestamp ?? ''}${anyWords ? ` matched=[${m.matchedWords.join(',')}] best_score=${m.score}` : ''}${forkNote(m)}`,
        `path=${m.path}`,
        `  BEST ${m.match.role}: ${previewMatch(m)}`,
      ]
    : (m) => [
        `${m.source} id=${m.id} idx=${m.index} ts=${m.timestamp ?? ''}${anyWords ? ` matched=[${m.matchedWords.join(',')}] score=${m.score}` : ''}${forkNote(m)}`,
        `path=${m.path}`,
        ...m.before.map((b) => `  before ${b.role}: ${truncate(b.text, CONTEXT_PREVIEW_CHARS)}`),
        `  MATCH ${m.match.role}: ${previewMatch(m)}`,
        ...m.after.map((a) => `  after  ${a.role}: ${truncate(a.text, CONTEXT_PREVIEW_CHARS)}`),
      ];
  // "\n[N] " between entries grows with the hit number — charge the widest it can get.
  const idxOverhead = String(limited.length).length + 4;
  const entryLen = (m) => renderLines(m).reduce((t, l) => t + bytes(l) + 1, idxOverhead);
  const header = (shown) => `query=${JSON.stringify(queryEcho)}${scopedSessionFile ? ` session=${sessionId(scopedSessionFile)}` : ''}${opts.regex ? ' regex=true' : ''}${opts.any ? ` any=true` : ''}${literalMultiword ? ' literal_multiword=true (retry with --any; literal phrases rarely occur verbatim)' : ''}${opts.candidates ? ` candidate_sessions=${candidates.length}` : ''} files_with_matches=${filesWithMatches} total_message_matches=${matches.length}${toolsExcluded > 0 && !opts.includeTools ? ` tools_excluded=${toolsExcluded} (add --include-tools)` : ''}${skillBodiesExcluded > 0 && !opts.includeSkillBodies ? ` skill_excluded=${skillBodiesExcluded} (add --include-skill-bodies)` : ''} shown=${shown} sort=${opts.sort}${opts.since ? ` since=${opts.since}` : ''}${opts.until ? ` until=${opts.until}` : ''}${opts.caseSensitive ? ' case_sensitive=true' : ''}${opts.excludeSessions.length ? ` excluded_sessions=[${opts.excludeSessions.join(',')}]` : ''}`;
  let wordStatsLine = wordStats ? `word_hits: ${truncate(wordStats, 300)} (of ${messagesScanned} messages searched after filters; high-count words are low-signal — prefer the rare ones)` : null;
  const hintLine = hint ? `hint: ${hint}` : null;
  const room = (withOmit) => opts.maxChars
    - bytes(header(limited.length)) - 1
    - (wordStatsLine ? bytes(wordStatsLine) + 1 : 0)
    - (hintLine ? bytes(hintLine) + 1 : 0)
    - (withOmit && limited.length ? bytes(OMIT(limited.length)) + 2 : 0);
  // A df table that can't fit is dropped even with zero hits — the ceiling binds always.
  if (wordStatsLine && room(false) < 0) wordStatsLine = null;
  // Two-phase: the omission note only prints when hits are omitted, so charge its
  // reserve only when selection actually falls short of the full list.
  let emitted = selectWithinBudget(entryLen, room(false));
  if (emitted.length < limited.length) {
    emitted = selectWithinBudget(entryLen, room(true));
    if (!emitted.length && wordStatsLine) {
      wordStatsLine = null;
      emitted = selectWithinBudget(entryLen, room(true));
    }
    // Emitting the sole hit means nothing is omitted, so no note reserve applies then.
    if (!emitted.length) emitted = forceOneHit(entryLen, room(limited.length > 1));
  }
  const omitted = limited.length - emitted.length;
  console.log(header(emitted.length));
  if (wordStatsLine) console.log(wordStatsLine);
  if (hintLine) console.log(hintLine);
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
        ...(match.matchedWords ? { bestMatchedWords: match.matchedWords } : {}),
        hitCount: 0,
        match: match.match,
        ...(match.forkCopies ? { forkCopies: match.forkCopies } : {}),
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

// A message with no timestamp falls back to its file's mtime, so a file last written
// before the window holds nothing inside it. One stat replaces a full parse.
// What the default exclusions hid, per exclusion so the caller learns which flag to
// add. Only a thin result asks for it: a full one hides the same corpus-wide share
// every time, and answering costs a reparse of every prefilter-eligible file.
function recountExcludedMatches(candidates) {
  for (const file of candidates) {
    const source = sourceOf(file);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const records = parseRecords(raw);
    let fileMtime = null;
    const mtime = () => (fileMtime ??= fs.statSync(file).mtimeMs);
    const visible = countMatching(messagesFrom(records, source), mtime);
    const toolsLifted = countMatching(messagesFrom(records, source, { includeTools: true }), mtime);
    if (!opts.includeTools) toolsExcluded += Math.max(0, toolsLifted - visible);
    if (!opts.includeSkillBodies) {
      const allLifted = countMatching(
        messagesFrom(records, source, { includeTools: true, includeSkillBodies: true }), mtime);
      skillBodiesExcluded += Math.max(0, allLifted - Math.max(toolsLifted, visible));
    }
  }
}

function filesWrittenSince(candidates, cutoff) {
  return candidates.filter((file) => {
    try { return fs.statSync(file).mtimeMs >= cutoff; } catch { return false; }
  });
}

function countOccurrences(haystack, word) {
  if (!word) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(word, i)) !== -1) {
    n++;
    i += word.length;
  }
  return n;
}

// FNV-1a over each message in turn: cheap, order-sensitive, and accumulated in one
// pass so a file with many hits does not re-read its own prefix per hit.
function extendPrefix(hash, text) {
  const norm = normalizeForKey(text);
  let h = hash;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normalizeForKey(text) {
  const norm = text.replace(/\s+/g, ' ').trim();
  return opts.caseSensitive ? norm : norm.toLowerCase();
}

function contentKey(match) {
  // A fork replays its ancestor's prefix, so a copy shares both the parser and the
  // session's first message. Same sentence under a different opening is a coincidence.
  return `${match.source}\0${match.replayedPrefix}\0${normalizeForKey(match.match.text)}`;
}

function collapseForks(ranked, cmp) {
  const groups = new Map();
  for (const match of ranked) {
    // No prefix means nothing was replayed, so two sessions sharing only this message
    // are a coincidence, not a fork family.
    if (match.replayedPrefix === PREFIX_SEED) { groups.set(`\0solo\0${groups.size}`, [match]); continue; }
    const key = contentKey(match);
    const group = groups.get(key);
    if (group) group.push(match);
    else groups.set(key, [match]);
  }
  if (groups.size === ranked.length) return ranked;
  const kept = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    let ancestor = group[0];
    let best = group[0];
    for (const match of group) {
      if (match.time < ancestor.time || (match.time === ancestor.time && stable(match, ancestor) < 0)) ancestor = match;
      if (cmp(match, best) < 0) best = match;
    }
    kept.push({ ...ancestor, forkCopies: group.length - 1, score: best.score, rankTime: best.time });
  }
  return kept.sort((a, b) => cmp(
    { ...a, time: a.rankTime ?? a.time },
    { ...b, time: b.rankTime ?? b.time },
  ));
}

function sourceOf(file) {
  const configured = configuredSourceOf(file, sourceMap, sourceNames);
  if (configured) return configured;
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.detect(file)) return name;
  }
}

// Invoking a slash command injects the whole SKILL.md into the transcript as a user
// message. That body is documentation, not conversation: it measured 12.8% of the
// conversational bytes in this machine's Claude store at ~5.8KB a copy, and it matches
// its own vocabulary, so it crowds real hits out of the bounded output budget.
//
// Reduce it in place rather than dropping the message, so the index stays aligned and a
// --session/--at pointer still lands where the hit said it would. The substituted marker
// is a display placeholder only — the ripgrep prefilter matches raw file bytes, which
// still hold the original body, so the marker text itself is not searchable. The separate
// <command-message>/<command-name>/<command-args> record is untouched — that is the
// invocation event, and command-args carries what the person actually asked for — that
// record is what keeps "when did I last invoke X" answerable.
// --include-skill-bodies restores the raw text for searching the documentation itself.
function reduceSkillBody(msg) {
  // Declared inside the hoisted function: top-level search runs before this point in
  // module order, so a module-scope const would be in its temporal dead zone.
  // Claude Code opens the injection with the skill's base directory; Codex wraps it in
  // <skill><name>. Both carry the whole SKILL.md after that point.
  const claude = /^\s*Base directory for this skill:\s*(\S+)/.exec(msg.text);
  if (claude) return { ...msg, text: `[skill body omitted: ${path.basename(claude[1])}]` };
  const codex = /^\s*<skill>\s*<name>([^<]+)<\/name>/.exec(msg.text);
  if (codex) return { ...msg, text: `[skill body omitted: ${codex[1].trim()}]` };
  return msg;
}

// JSON.parse dominates on multi-MB transcripts and every exclusion view needs the
// same lines, so callers parse once and build each view from the records.
function parseRecords(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { continue; }
  }
  return out;
}

function messagesFrom(records, source, overrides = {}) {
  const includeTools = overrides.includeTools ?? opts.includeTools;
  const includeSkillBodies = overrides.includeSkillBodies ?? opts.includeSkillBodies;
  const out = [];
  for (const obj of records) {
    const msg = ADAPTERS[source].message(obj, { includeTools });
    if (!msg || !msg.text.trim()) continue;
    out.push(includeSkillBodies ? msg : reduceSkillBody(msg));
  }
  return out;
}

function parseMessages(raw, source, overrides = {}) {
  return messagesFrom(parseRecords(raw), source, overrides);
}

// Predicate shared by the visible search and the excluded-match recount below:
// same role/--since filtering, same literal/--any/--regex test, but without
// touching wordDf/messagesScanned (those describe the visible population).
function countMatching(messages, mtime) {
  let n = 0;
  for (const msg of messages) {
    if (opts.role !== 'all' && msg.role !== opts.role) continue;
    if (sinceTime != null || untilTime != null) {
      const time = timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? mtime();
      if (sinceTime != null && time < sinceTime) continue;
      if (untilTime != null && time >= untilTime) continue;
    }
    const haystack = opts.caseSensitive ? msg.text : msg.text.toLowerCase();
    if (anyWords) {
      if (!anyWords.some((w) => haystack.includes(w))) continue;
    } else if (opts.regex ? !queryRegex.test(msg.text) : !haystack.includes(q)) continue;
    n++;
  }
  return n;
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
  return out.sort(); // readdir order varies; keep browse/window resolution deterministic
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
    // The header is budgeted too: a deep path must not bust a small budget on line one.
    const header = truncate(`skim id=${sessionId(file)} messages=${messages.length} path=${file}`, opts.maxChars - 160);
    // A short conversation should be lossless: --max-chars is the actual aperture. The old
    // eager 200-char clip discarded decisive facts even when the complete session was only
    // ~1KB, forcing agents into repeated synonym queries that could never recover the tail.
    const fullLines = messages.map((m, i) => line(m, i, null));
    const fullOutput = `${[header, ...fullLines].join('\n')}\n`;
    if (bytes(fullOutput) <= opts.maxChars) {
      process.stdout.write(fullOutput);
      return;
    }
    // Large sessions retain the eval-proven sampled conversational spine.
    const lines = messages.map((m, i) => line(m, i, 200));
    const total = lines.reduce((t, l) => t + bytes(l) + 1, 0);
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
    // The average only ESTIMATES the sample count; the complete rendered result (headers
    // and sampling markers included) is then measured in BYTES and the sample reduced
    // until the requested aperture is truly honored.
    const minimumKeep = lines.length >= 2 ? 2 : 1;
    let keep = Math.min(lines.length, Math.max(minimumKeep, Math.floor((opts.maxChars - bytes(header) - 1) / Math.max(1, avg))));
    let sampledOutput = '';
    while (keep >= minimumKeep) {
      sampledOutput = renderSample(sampleIndexes(keep));
      if (bytes(sampledOutput) <= opts.maxChars) break;
      keep--;
    }
    if (bytes(sampledOutput) <= opts.maxChars) {
      process.stdout.write(sampledOutput);
      return;
    }
    // Even at the minimum aperture, retain both ends. Shrink their previews only
    // after reducing the sampled spine to its head and tail.
    if (lines.length >= 2) {
      const notice = `  ... ${lines.length - 2} messages sampled out ...`;
      const fixedBytes = bytes(header) + bytes(notice) + 4; // four rendered newlines
      const share = Math.max(1, Math.floor((opts.maxChars - fixedBytes) / 2));
      const fallback = `${[header, truncate(lines[0], share), notice, truncate(lines[lines.length - 1], share)].join('\n')}\n`;
      process.stdout.write(fallback);
      return;
    }
    process.stdout.write(`${header}\n${truncate(lines[0], Math.max(1, opts.maxChars - bytes(header) - 2))}\n`);
    return;
  }

  // --overview
  const digests = [];
  for (const file of files) {
    const source = sourceOf(file);
    // A file's mtime is its last write, so it is never older than its newest message.
    // When --since is set, an older mtime therefore guarantees lastTime < sinceTime and
    // the digest would be dropped below anyway — skip the read+parse instead of doing
    // 2.5GB of work to discard it. Errs toward including (a restored file looks new).
    if (sinceTime != null) {
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtime < sinceTime) continue;
    }
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
      opening: truncate(openingText(first.text), 220),
      lastTime,
    });
  }
  digests.sort((a, b) => b.lastTime - a.lastTime);
  const head0 = `sessions=${digests.length} (newest first) — drill in with --skim ID or --query`;
  console.log(head0);
  let size = bytes(head0) + 1 + 64; // 64: reserve for the omission notice
  for (const d of digests) {
    const block = `\nid=${d.id} source=${d.source} ${d.from} -> ${d.to} msgs=${d.user}u/${d.assistant}a size=${d.mb}MB\n  opening: ${d.opening}`;
    if (size + bytes(block) + 1 > opts.maxChars) {
      console.log(`\n... remaining sessions omitted by --max-chars budget`);
      break;
    }
    size += bytes(block) + 1;
    console.log(block);
  }
}

// Byte-budgeted truncation (n is bytes, ≈ chars for ASCII). Never splits a surrogate
// pair, so CJK/emoji previews stay valid text and cost what they claim.
// The first user message of a harness-launched session opens with injected preamble
// (worktree system-reminders, a slash command's own header) rather than what the person
// actually asked. That preamble is the same in every such session, so showing it makes
// the digest's one signal-bearing field useless. Strip the leading wrapper blocks; if
// nothing else is left, keep the original so the digest never shows a blank opening.
function openingText(text) {
  const stripped = text
    .replace(/^\s*Caveat: The messages below[^]*?<\/command-message>/, '')
    .replace(/<system-reminder>[^]*?<\/system-reminder>/g, '')
    .replace(/<command-(?:message|name)>[^]*?<\/command-(?:message|name)>/g, '')
    // command-args is the person's actual ask, so unwrap it rather than dropping it.
    .replace(/<command-args>([^]*?)<\/command-args>/g, '$1')
    .trim();
  return stripped || text;
}

function truncate(s, n) {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(oneLine) <= n) return oneLine;
  let end = Math.min(oneLine.length, n);
  while (end > 0 && Buffer.byteLength(oneLine.slice(0, end)) > n - 3) end--;
  let cut = oneLine.slice(0, end);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}...`;
}

function truncateAround(s, n, needle) {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(oneLine) <= n) return oneLine;
  if (n <= 3) return '...';
  const hay = opts.caseSensitive ? oneLine : oneLine.toLowerCase();
  const key = needle ? (opts.caseSensitive ? String(needle) : String(needle).toLowerCase()) : '';
  const focus = key ? hay.indexOf(key) : -1;
  if (focus < 0) return truncate(s, n);

  let lo = focus;
  let hi = Math.min(oneLine.length, focus + key.length);
  const cost = (left, right) => {
    let c = Buffer.byteLength(oneLine.slice(left, right));
    if (left > 0) c += 3;
    if (right < oneLine.length) c += 3;
    return c;
  };
  if (cost(lo, hi) > n) {
    const clipped = truncate(oneLine.slice(lo), n - (lo > 0 ? 3 : 0));
    return lo > 0 ? `...${clipped}` : clipped;
  }

  const prev = (i) => (i > 1 && /[\uDC00-\uDFFF]/.test(oneLine[i - 1]) ? i - 2 : i - 1);
  const next = (i) => (i < oneLine.length && /[\uD800-\uDBFF]/.test(oneLine[i]) ? Math.min(oneLine.length, i + 2) : i + 1);
  while (lo > 0 || hi < oneLine.length) {
    const nextLo = lo > 0 ? prev(lo) : lo;
    const nextHi = hi < oneLine.length ? next(hi) : hi;
    const canLeft = lo > 0 && cost(nextLo, hi) <= n;
    const canRight = hi < oneLine.length && cost(lo, nextHi) <= n;
    if (!canLeft && !canRight) break;
    const leftSpan = focus - lo;
    const rightSpan = hi - (focus + key.length);
    if (canLeft && (!canRight || leftSpan <= rightSpan)) lo = nextLo;
    else hi = nextHi;
  }
  let out = oneLine.slice(lo, hi);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  if (lo > 0) out = `...${out}`;
  if (hi < oneLine.length) out = `${out}...`;
  return out;
}

function timeOf(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// --until is an exclusive upper bound that includes the period it names, so
// `--since today --until today` is today and `--until 2026-05-03` keeps that date.
function parseUntil(value) {
  const start = parseSince(value);
  if (start == null) return null;
  return /^\d+d$/.test(value) ? start : start + DAY_MS;
}

function parseSince(value) {
  const now = new Date();
  if (value === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = value.match(/^(\d+)d$/);
  if (days) return now.getTime() - Number(days[1]) * DAY_MS;
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
  const out = code === 0 ? console.log : console.error;
  if (msg) console.error(msg);
  out('Usage: session-grep.mjs --query TEXT [options] | --overview | --skim ID | --session ID --at INDEX [--focus TEXT] | --list-roots | --self-test');
  if (code === 0 || !msg) {
    const width = Math.max(...FLAGS.map(([flag, arg]) => flag.length + (arg ? arg.length + 1 : 0)));
    for (const [flag, arg, desc] of FLAGS) out(`  ${(arg ? `${flag} ${arg}` : flag).padEnd(width)}  ${desc}`);
  }
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
  // Session CJK: Japanese text — exercises byte (not UTF-16) budget accounting.
  let cj = '';
  for (let i = 0; i < 20; i++) cj += line(i % 2 ? 'assistant' : 'user', text(`現地時間のバグについての議論 その${i} — タイムゾーン変換が失敗する`), `2026-06-03T10:${String(i).padStart(2, '0')}:00Z`);
  fs.writeFileSync(path.join(proj, 'cjkcjk11.jsonl'), cj);
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
  // Reasoning traces: Claude plaintext thinking blocks + Codex agent_reasoning are
  // conversation text (always searched); encrypted Codex reasoning stays skipped.
  fs.writeFileSync(path.join(proj, 'rrrr6666.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-12T08:00:00Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SELFTEST-REASONHIT claude deliberation about the cache', signature: 'sig' }] } }) + '\n');
  fs.appendFileSync(path.join(dir, 'codex', 'rollout-cccc.jsonl'),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-07T08:00:01Z', payload: { type: 'agent_reasoning', text: 'SELFTEST-REASONHIT codex deliberation about the cache' } }) + '\n' +
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-07T08:00:02Z', payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'SELFTEST-ENCRYPTEDNOISE' } }) + '\n');

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
    // #22: a miss caused only by tool exclusion must name the lever, on both the
    // zero-hit path and a thin result — not read as "absent from the corpus".
    check('zero-hit tool-only miss signals --include-tools',
      withoutTools.excluded?.tools === 1 && /add --include-tools/.test(withoutTools.hint));
    const thinTools = JSON.parse(run(['--query', 'flumoxide', '--json']));
    check('thin result still reports matches hidden in tool blocks',
      thinTools.totalMatches === 1 && thinTools.excluded?.tools === 1);
    const thinText = run(['--query', 'flumoxide']);
    check('text header carries the tools_excluded signal', /tools_excluded=1 \(add --include-tools\)/.test(thinText));
    // #24: multi-word literal guidance is proactive — in the header on hits too —
    // while matching semantics stay literal.
    const multiText = run(['--query', 'flumoxide bug came']);
    check('multi-word literal header advises --any proactively', /literal_multiword=true \(retry with --any/.test(multiText));
    const multiJson = JSON.parse(run(['--query', 'flumoxide bug came', '--json']));
    check('multi-word literal keeps literal semantics', multiJson.literalMultiword === true && multiJson.totalMatches === 1);
    const singleJson = JSON.parse(run(['--query', 'flumoxide', '--json']));
    check('single-term query carries no literal_multiword flag', !('literalMultiword' in singleJson));

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

    // budget enforcement: the budget is a hard byte ceiling, all lines charged
    const tiny = run(['--query', 'sidebar', '--limit', '30', '--max-chars', '600']);
    check('budget is a hard byte ceiling', Buffer.byteLength(tiny) <= 600);
    check('omission notice present', tiny.includes('omitted by the 600-byte output budget'));
    const tinyShown = Number(tiny.match(/shown=(\d+)/)[1]);
    check('header shown = emitted blocks', (tiny.match(/\n\[\d+\]/g) || []).length === tinyShown);
    const tokens = run(['--query', 'sidebar', '--limit', '30', '--max-tokens', '200']);
    check('--max-tokens = 4 bytes per token', Buffer.byteLength(tokens) <= 800);
    const tinyJson = run(['--query', 'sidebar', '--limit', '30', '--max-chars', '600', '--json']);
    check('json budget is a hard byte ceiling', Buffer.byteLength(tinyJson) <= 600);
    check('json still parses under budget pressure', JSON.parse(tinyJson).shown >= 1);
    // evidence outranks metadata: common --any words + small budget must still show a hit
    const crowded = run(['--query', 'sidebar discussion chatter project segment', '--any', '--limit', '30', '--max-chars', '800']);
    check('crowded budget still shows evidence', Number(crowded.match(/shown=(\d+)/)[1]) >= 1);
    check('crowded budget stays under ceiling', Buffer.byteLength(crowded) <= 800);
    // a huge query must not blow the budget echoing itself in the header
    const longQ = run(['--query', 'z'.repeat(1500), '--max-chars', '500']);
    check('long query echo truncated', Buffer.byteLength(longQ) <= 500);
    // zero hits must not exempt metadata from the ceiling: a many-word --any miss
    // would otherwise dump its whole df table
    const missWords = Array.from({ length: 120 }, (_, i) => `zzmiss${i}`).join(' ');
    const missText = run(['--query', missWords, '--any', '--max-chars', '500']);
    check('zero-hit text under ceiling', Buffer.byteLength(missText) <= 500);
    const missJson = run(['--query', missWords, '--any', '--max-chars', '500', '--json']);
    check('zero-hit json under ceiling', Buffer.byteLength(missJson) <= 500);
    check('zero-hit json still parses', JSON.parse(missJson).totalMatches === 0);
    // non-ASCII: bytes, not UTF-16 units — CJK output must respect the same ceiling
    const cjk = run(['--query', '現地時間', '--limit', '30', '--max-chars', '600']);
    check('cjk query finds hits', Number(cjk.match(/shown=(\d+)/)[1]) >= 1);
    check('cjk budget is a hard byte ceiling', Buffer.byteLength(cjk) <= 600);
    const cjkSkim = run(['--skim', 'cjkcjk11', '--max-chars', '900']);
    check('cjk skim within byte budget', Buffer.byteLength(cjkSkim) <= 900);
    // word_hits describes the population after --role/--since filters
    const dfAll = JSON.parse(run(['--query', 'sidebar flumoxide', '--any', '--json']));
    const dfUser = JSON.parse(run(['--query', 'sidebar flumoxide', '--any', '--role', 'user', '--json']));
    check('word df counted after filters', dfUser.wordHits.sidebar < dfAll.wordHits.sidebar);
    // shown>=1 even when the only match lives under a deeply nested path
    const deep = path.join(dir, 'deep', ...Array.from({ length: 12 }, (_, i) => `nested-directory-level-${i}`));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deepdeep1.jsonl'), line('user', text('DEEPNEEDLE only match here'), '2026-06-12T08:00:00Z'));
    const deepText = run(['--query', 'DEEPNEEDLE', '--max-chars', '500']);
    check('deep-path text still shows the hit', /shown=1/.test(deepText));
    check('deep-path text under ceiling', Buffer.byteLength(deepText) <= 500);
    const deepJson = JSON.parse(run(['--query', 'DEEPNEEDLE', '--max-chars', '500', '--json']));
    check('deep-path json still shows the hit', deepJson.shown === 1);
    const deepWin = run(['--session', 'deepdeep1', '--at', '0', '--max-chars', '500']);
    check('deep-path window under ceiling', Buffer.byteLength(deepWin) <= 500);
    const deepSkim = run(['--skim', 'deepdeep1', '--max-chars', '500']);
    check('deep-path skim under ceiling', Buffer.byteLength(deepSkim) <= 500);

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
    // Overview preamble/prune checks live in their own root so the fixtures cannot
    // perturb the file and session counts the other cases assert on.
    const ovDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-grep-overview-'));
    const ovRun = (args) => runRaw([...args, '--root', ovDir]);
    const ovOpening = (out, id) => {
      const lines = out.split('\n');
      return lines[lines.findIndex((l) => l.includes(id)) + 1] ?? '';
    };
    fs.writeFileSync(path.join(ovDir, 'keep1111.jsonl'), line('user', text('KEEPMARKER in window'), '2026-06-20T08:00:00Z'));
    // --since prunes by file mtime before reading; a file whose mtime predates the
    // window must drop out, and one written inside it must survive the shortcut.
    const staleFile = path.join(ovDir, 'stale111.jsonl');
    fs.writeFileSync(staleFile, line('user', text('STALEONLY marker'), '2026-06-20T08:00:00Z'));
    fs.utimesSync(staleFile, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const ovStale = ovRun(['--overview', '--since', '2026-06-06', '--max-chars', '20000']);
    check('overview mtime prune drops a stale file', !ovStale.includes('stale111'));
    check('overview mtime prune keeps in-window files', ovStale.includes('keep1111'));
    // the digest opening shows the ask, not the harness preamble wrapped around it
    fs.writeFileSync(path.join(ovDir, 'preamb11.jsonl'), line('user', text(
      '<system-reminder>You are operating in a git worktree.</system-reminder> <command-message>do-thing</command-message> <command-name>/do-thing</command-name> <command-args>REALASK about the sidebar</command-args>',
    ), '2026-06-21T08:00:00Z'));
    // a session whose whole first message is the invocation keeps it rather than blanking
    fs.writeFileSync(path.join(ovDir, 'onlycmd1.jsonl'), line('user', text(
      '<command-message>bare</command-message> <command-name>/bare</command-name>',
    ), '2026-06-22T08:00:00Z'));
    const ovOpen = ovRun(['--overview', '--since', '2026-06-06', '--max-chars', '20000']);
    const openText = ovOpening(ovOpen, 'preamb11');
    check('opening strips injected preamble', openText.includes('REALASK') && !openText.includes('system-reminder'));
    check('opening falls back rather than blanking', /\/bare/.test(ovOpening(ovOpen, 'onlycmd1')));

    // Injected slash-command skill bodies are excluded from matching, but the invocation
    // event survives and the message index stays aligned for --session/--at pointers.
    const skDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-grep-skillbody-'));
    const skRun = (args) => runRaw([...args, '--root', skDir]);
    fs.writeFileSync(path.join(skDir, 'skillinj.jsonl'),
      line('user', text('<command-message>demo-skill</command-message> <command-name>/demo-skill</command-name> <command-args>find the FLUMOXIDE report</command-args>'), '2026-06-20T08:00:00Z')
      + line('user', text('Base directory for this skill: /home/u/.claude/skills/demo-skill\n\n# demo-skill\n\nSearches things with QUOKKAWORD matching.'), '2026-06-20T08:00:01Z')
      + line('assistant', text('QUOKKAWORD appears here in real conversation.'), '2026-06-20T08:00:02Z'));
    const bodyOff = JSON.parse(skRun(['--query', 'QUOKKAWORD', '--json']));
    check('skill body excluded from matching by default', bodyOff.totalMatches === 1
      && bodyOff.matches[0].role !== 'user');
    const bodyOn = JSON.parse(skRun(['--query', 'QUOKKAWORD', '--include-skill-bodies', '--json']));
    check('--include-skill-bodies restores the body', bodyOn.totalMatches === 2);
    const evt = JSON.parse(skRun(['--query', 'FLUMOXIDE', '--json']));
    check('invocation event survives exclusion', evt.totalMatches === 1 && evt.matches[0].index === 0);
    // The marker is a display placeholder, not an index: the ripgrep prefilter matches raw
    // file bytes, which still hold the original body, so the substituted text is unsearchable.
    // Codex wraps the same injection differently; both formats reduce.
    fs.writeFileSync(path.join(skDir, 'codexinj.jsonl'),
      line('user', text('<skill>\n<name>demo-skill</name>\n<path>/home/u/.agents/skills/demo-skill/SKILL.md</path>\n---\nSearches things with QUOKKAWORD matching.'), '2026-06-20T09:00:00Z'));
    const codexOff = JSON.parse(skRun(['--query', 'QUOKKAWORD', '--json']));
    check('codex <skill> injection excluded too', codexOff.totalMatches === 1);
    const codexOn = JSON.parse(skRun(['--query', 'QUOKKAWORD', '--include-skill-bodies', '--json']));
    check('--include-skill-bodies restores both formats', codexOn.totalMatches === 3);
    const named = JSON.parse(skRun(['--query', 'skill body omitted', '--json']));
    check('substituted marker is not itself searchable', named.totalMatches === 0);
    // The body message keeps its slot, so a pointer past it still lands correctly.
    const window = skRun(['--session', 'skillinj', '--at', '2', '--before', '2', '--after', '0']);
    check('reduced body keeps the index aligned', /\[skill body omitted: demo-skill\]/.test(window)
      && /QUOKKAWORD appears here/.test(window));

    // Ranking + output-budget policy: forks collapse, BM25 prefers short hits,
    // oversized previews keep the match span, --candidates BEST is the best score.
    const rkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-grep-rank-'));
    const rkRun = (args) => runRaw([...args, '--root', rkDir]);
    // A resume replays the ancestor's prefix, so each copy carries the same opening
    // turn before the shared message. Without that prefix there is no fork evidence.
    const sharedFork = 'FORKNEEDLE confirmed the form-fill event and the tool-result loop.';
    const replay = (ts) => line('user', text('Trace the terminal form-fill event'), ts)
      + line('assistant', text(sharedFork), ts);
    fs.writeFileSync(path.join(rkDir, 'ancestor.jsonl'), replay('2026-04-06T21:26:18Z'));
    fs.writeFileSync(path.join(rkDir, 'resume1.jsonl'), replay('2026-04-10T17:29:13Z'));
    fs.writeFileSync(path.join(rkDir, 'other.jsonl'), line('assistant', text('FORKNEEDLE UNIQUEFORK later'), '2026-04-11T09:00:00Z'));
    // Two one-message sessions with identical text share no replayed prefix, so they
    // are a coincidence and must both survive.
    fs.writeFileSync(path.join(rkDir, 'solo-a.jsonl'), line('user', text('SOLOPAIR standalone question'), '2026-04-12T09:00:00Z'));
    fs.writeFileSync(path.join(rkDir, 'solo-b.jsonl'), line('user', text('SOLOPAIR standalone question'), '2026-04-13T09:00:00Z'));
    const solos = JSON.parse(rkRun(['--query', 'SOLOPAIR', '--json', '--max-chars', '4000']));
    check('identical one-message sessions are not a fork family',
      solos.totalMatches === 2 && solos.shown === 2
      && solos.matches.every((m) => m.forkCopies === undefined));
    const forks = JSON.parse(rkRun(['--query', 'FORKNEEDLE', '--json', '--max-chars', '4000']));
    check('fork copies collapse onto the ancestor', forks.totalMatches === 3 && forks.shown === 2
      && forks.matches.some((m) => m.id === 'ancestor' && m.forkCopies === 1)
      && forks.matches.some((m) => m.match.text.includes('UNIQUEFORK')));
    fs.writeFileSync(path.join(rkDir, 'short.jsonl'), line('assistant', text('rankoxide'), '2026-06-01T10:00:00Z'));
    fs.writeFileSync(path.join(rkDir, 'long.jsonl'), line('assistant', text(`${'padding '.repeat(800)} rankoxide ${'padding '.repeat(800)}`), '2026-06-02T10:00:00Z'));
    const ranked = JSON.parse(rkRun(['--query', 'rankoxide', '--any', '--json', '--max-chars', '8000']));
    const shortHit = ranked.matches.find((m) => m.id === 'short');
    const longHit = ranked.matches.find((m) => m.id === 'long');
    check('BM25 prefers a short hit over a newer long mention', shortHit && longHit && shortHit.score > longHit.score);
    const blob = `STARTTOKEN ${'padding '.repeat(2000)} OVERSIZEHIT MIDFACT ${'padding '.repeat(2000)}`;
    fs.writeFileSync(path.join(rkDir, 'huge-a.jsonl'), line('assistant', text(blob), '2026-07-01T10:00:00Z'));
    fs.writeFileSync(path.join(rkDir, 'huge-b.jsonl'), line('assistant', text(blob.replace('MIDFACT', 'MIDFACT-B')), '2026-07-02T10:00:00Z'));
    const huge = JSON.parse(rkRun(['--query', 'OVERSIZEHIT', '--json', '--before', '0', '--after', '0', '--max-chars', '12000']));
    check('oversized hits keep the match span and share the aperture', huge.shown >= 2
      && huge.matches.every((m) => m.match.text.includes('OVERSIZEHIT') && !m.match.text.includes('STARTTOKEN'))
      && huge.matches.every((m) => Buffer.byteLength(m.match.text) <= 4000));
    fs.writeFileSync(path.join(rkDir, 'wrapped.jsonl'),
      line('assistant', text('wrapoxide is the spawnSync cause'), '2026-08-01T10:00:00Z')
      + line('user', text(`${'Untrusted agent history for review. '.repeat(80)} wrapoxide once.`), '2026-08-01T10:00:05Z'));
    const best = JSON.parse(rkRun(['--query', 'wrapoxide', '--any', '--candidates', '--json']));
    const wrapped = best.candidates.find((c) => c.id === 'wrapped');
    check('--candidates BEST is the short on-topic hit', wrapped?.match.role === 'assistant' && /spawnSync/.test(wrapped.match.text));

    const spine = run(['--skim', 'aaaa1111', '--max-chars', '900']);
    check('skim rendered output stays within byte budget', Buffer.byteLength(spine) <= 900);
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

    // reasoning traces are conversation text: searched by default, never tool-gated
    const reason = JSON.parse(run(['--query', 'SELFTEST-REASONHIT', '--json']));
    check('claude thinking + codex agent_reasoning searchable by default',
      reason.totalMatches === 2 && new Set(reason.matches.map((m) => m.source)).size === 2
      && reason.matches.every((m) => m.match.role === 'assistant'));
    const encrypted = JSON.parse(run(['--query', 'SELFTEST-ENCRYPTEDNOISE', '--json']));
    check('encrypted codex reasoning stays skipped', encrypted.totalMatches === 0);

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
    // Issue #20: a subdirectory of a configured root narrows to that subdirectory and
    // inherits its parser type; a path under no configured root still fails closed.
    fs.mkdirSync(path.join(dir, 'moved', 'subproj'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'moved', 'subproj', 'sub00001.jsonl'),
      line('assistant', text('SUBROOTMARKER scoped to one project'), '2026-06-09T09:00:00Z'));
    const targetedSub = JSON.parse(runRaw(['--query', 'SUBROOTMARKER', '--json', '--sources-file', sourcesFile, '--target-root', path.join(dir, 'moved', 'subproj')]));
    check('--target-root subdirectory inherits configured type', targetedSub.totalMatches === 1 && targetedSub.matches[0].source === 'claude');
    const targetedSubMiss = JSON.parse(runRaw(['--query', 'movedclaude', '--json', '--sources-file', sourcesFile, '--target-root', path.join(dir, 'moved', 'subproj')]));
    check('--target-root subdirectory excludes sibling files', targetedSubMiss.totalMatches === 0);
    const targetedOutside = spawnSync(process.execPath, [self, '--query', 'x', '--sources-file', sourcesFile, '--target-root', path.join(os.tmpdir(), 'session-grep-outside-root')], { encoding: 'utf8' });
    check('--target-root outside configured roots fails closed', targetedOutside.status === 1 && targetedOutside.stderr.includes('--target-root did not match any configured roots'));
    // Issue #19: raw_files_with_hits describes the scope actually searched, not the
    // prefilter total across excluded types.
    const scopedCount = JSON.parse(runRaw(['--query', 'zorptastic', '--json', '--sources-file', sourcesFile, '--target-type', 'claude']));
    check('--target-type scopes raw_files_with_hits', scopedCount.totalMatches === 0 && scopedCount.rawFilesWithHits === 0);
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

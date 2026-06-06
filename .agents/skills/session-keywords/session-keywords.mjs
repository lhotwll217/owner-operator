#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const keywordCsvPath = path.join(scriptDir, 'keywords.csv');
const args = process.argv.slice(2);
const opts = { limit: 20, before: 1, after: 1, role: 'all', source: 'all', json: false };

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--keyword') opts.keyword = args[++i];
  else if (a === '--list') opts.list = true;
  else if (a === '--limit') opts.limit = Number(args[++i]);
  else if (a === '--before') opts.before = Number(args[++i]);
  else if (a === '--after') opts.after = Number(args[++i]);
  else if (a === '--role') opts.role = args[++i];
  else if (a === '--source') opts.source = args[++i];
  else if (a === '--since') opts.since = args[++i];
  else if (a === '--json') opts.json = true;
  else if (a === '--add') opts.add = true;
  else if (a === '--description') opts.description = args[++i];
  else if (a === '--help' || a === '-h') usage(0);
  else usage(1, `Unknown arg: ${a}`);
}

const db = openKeywordDb(path.join(os.homedir(), '.owner-operator', 'keywords.db'), keywordCsvPath);
if (opts.add) {
  if (!opts.keyword) usage(1, '--add requires --keyword NAME');
  const name = normalizeKeyword(opts.keyword);
  addKeyword(db, name, opts.description || '');
  console.log(`added *${name}*${opts.description ? `: ${opts.description}` : ''}`);
  process.exit(0);
}
const keywords = loadKeywordsDb(db);
if (opts.list) {
  if (opts.json) console.log(JSON.stringify({ keywords }, null, 2));
  else for (const k of keywords) console.log(`${k.keyword}: ${k.description}`);
  process.exit(0);
}

const keyword = findKeyword(keywords, opts.keyword);
if (!keyword) usage(1, `Unknown keyword: ${opts.keyword || ''}. Run --list.`);
if (!Number.isFinite(opts.limit) || opts.limit < 1) usage(1, '--limit must be >= 1');
if (!Number.isFinite(opts.before) || opts.before < 0) usage(1, '--before must be >= 0');
if (!Number.isFinite(opts.after) || opts.after < 0) usage(1, '--after must be >= 0');
if (!['all', 'user', 'assistant'].includes(opts.role)) usage(1, '--role must be all, user, or assistant');
if (!['all', 'claude', 'codex'].includes(opts.source)) usage(1, '--source must be all, claude, or codex');
const sinceTime = opts.since ? parseSince(opts.since) : null;
if (opts.since && sinceTime == null) usage(1, '--since must be today, Nd, or YYYY-MM-DD');

const notation = `*${keyword.keyword}*`;
const matcher = buildKeywordMatcher(keyword.keyword);
const home = os.homedir();
const sourceRoots = {
  claude: [path.join(home, '.claude/projects')],
  codex: [path.join(home, '.codex/sessions'), path.join(home, '.codex/archived_sessions')],
};
const roots = Object.entries(sourceRoots)
  .filter(([source]) => opts.source === 'all' || opts.source === source)
  .flatMap(([, dirs]) => dirs)
  .filter((dir) => fs.existsSync(dir));

const rg = spawnSync('rg', [
  '--regexp', matcher.rgPattern,
  '--files-with-matches',
  '--glob', '*.jsonl',
  ...roots,
], { encoding: 'utf8' });

const files = rg.status === 0 ? rg.stdout.trim().split('\n').filter(Boolean) : [];
const matches = [];
for (const file of files) {
  const source = file.includes('/.codex/') ? 'codex' : 'claude';
  const messages = parseMessages(file, source);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (opts.role !== 'all' && msg.role !== opts.role) continue;
    if (!matcher.test(msg.text)) continue;
    const time = timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? fs.statSync(file).mtimeMs;
    if (sinceTime != null && time < sinceTime) continue;
    matches.push({
      source,
      id: path.basename(file, '.jsonl'),
      path: file,
      index: i,
      timestamp: msg.timestamp,
      time,
      before: messages.slice(Math.max(0, i - opts.before), i),
      match: msg,
      after: messages.slice(i + 1, i + 1 + opts.after),
    });
  }
}

matches.sort((a, b) => b.time - a.time);
const limited = matches.slice(0, opts.limit);

if (opts.json) {
  console.log(JSON.stringify({ keyword: { ...keyword, notation }, rawFilesWithHits: files.length, totalMatches: matches.length, count: limited.length, matches: limited }, null, 2));
} else {
  console.log(`keyword=${JSON.stringify(keyword.keyword)} notation=${JSON.stringify(notation)} description=${JSON.stringify(keyword.description)} raw_files_with_hits=${files.length} total_message_matches=${matches.length} shown=${limited.length}${opts.since ? ` since=${opts.since}` : ''}`);
  for (const [idx, m] of limited.entries()) {
    console.log(`\n[${idx + 1}] ${m.source} id=${m.id} idx=${m.index} ts=${m.timestamp ?? ''}`);
    console.log(`path=${m.path}`);
    for (const b of m.before) console.log(`  before ${b.role}: ${truncate(b.text, 180)}`);
    console.log(`  MATCH ${m.match.role}: ${truncate(m.match.text, 300)}`);
    for (const a of m.after) console.log(`  after  ${a.role}: ${truncate(a.text, 180)}`);
  }
}

function buildKeywordMatcher(value) {
  const words = normalizeKeyword(value).split(' ').filter(Boolean).map(escapeRegex);
  const inner = words.join('\\s+');
  return {
    rgPattern: `(?i)\\*\\s*${inner}\\s*\\*`,
    test: (text) => new RegExp(`\\*\\s*${inner}\\s*\\*`, 'i').test(text),
  };
}

function parseMessages(file, source) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = source === 'codex' ? codexMessage(obj) : claudeMessage(obj);
    if (!msg || !msg.text.trim()) continue;
    out.push(msg);
  }
  return out;
}

function claudeMessage(obj) {
  if ((obj.type === 'user' || obj.type === 'assistant') && obj.message && typeof obj.message === 'object') {
    return { role: obj.message.role || obj.type, text: contentToText(obj.message.content), timestamp: obj.timestamp };
  }
  return null;
}

function codexMessage(obj) {
  if (obj.type !== 'response_item' || !obj.payload || obj.payload.type !== 'message') return null;
  const role = obj.payload.role || 'unknown';
  if (!['user', 'assistant'].includes(role)) return null;
  const text = contentToText(obj.payload.content);
  if (text.startsWith('# AGENTS.md instructions') || text.startsWith('# Context from my IDE setup:') || text.startsWith('<turn_aborted>') || text.slice(0, 5000).includes('<environment_context>')) return null;
  return { role, text, timestamp: obj.timestamp };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks = [];
  for (const item of content) {
    if (typeof item === 'string') chunks.push(item);
    else if (item && typeof item === 'object') {
      for (const key of ['text', 'output_text', 'input_text', 'content']) {
        if (typeof item[key] === 'string') chunks.push(item[key]);
      }
    }
  }
  return chunks.join('\n');
}

function loadKeywords(file) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const [header, ...body] = rows;
  if (!header) return [];
  const keywordIndex = header.indexOf('keyword');
  const descriptionIndex = header.indexOf('description');
  return body.filter((row) => row[keywordIndex]).map((row) => ({
    keyword: normalizeKeyword(row[keywordIndex]),
    description: row[descriptionIndex] || '',
  }));
}

function openKeywordDb(dbFile, csvSeed) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE IF NOT EXISTS keywords (keyword TEXT PRIMARY KEY, description TEXT, created_at TEXT DEFAULT (datetime('now')))");
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM keywords').get();
  if (n === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO keywords (keyword, description) VALUES (?, ?)');
    for (const k of loadKeywords(csvSeed)) ins.run(k.keyword, k.description);
  }
  return db;
}

function loadKeywordsDb(db) {
  return db.prepare('SELECT keyword, description FROM keywords ORDER BY keyword').all()
    .map((r) => ({ keyword: r.keyword, description: r.description || '' }));
}

function addKeyword(db, keyword, description) {
  db.prepare("INSERT INTO keywords (keyword, description) VALUES (?, ?) ON CONFLICT(keyword) DO UPDATE SET description = excluded.description").run(keyword, description);
}

function findKeyword(keywords, value) {
  const target = normalizeKeyword(value || '');
  return keywords.find((k) => k.keyword === target);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normalizeKeyword(value) {
  return String(value).toLowerCase().trim().replace(/^[*\s]+|[*\s]+$/g, '').replace(/\s+/g, ' ');
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('Usage: session-keywords.mjs (--keyword NAME | --list | --add --keyword NAME --description "...") [--since today|7d|YYYY-MM-DD] [--limit N] [--before N] [--after N] [--role user|assistant|all] [--source claude|codex|all] [--json]');
  console.error('Keyword definitions live in ~/.owner-operator/keywords.db (seeded from keywords.csv on first run).');
  process.exit(code);
}

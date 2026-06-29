#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opts = { limit: 20, before: 1, after: 1, role: 'all', source: 'all', sort: 'newest', json: false, regex: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--query') opts.query = args[++i];
  else if (a === '--limit') opts.limit = Number(args[++i]);
  else if (a === '--before') opts.before = Number(args[++i]);
  else if (a === '--after') opts.after = Number(args[++i]);
  else if (a === '--role') opts.role = args[++i];
  else if (a === '--source') opts.source = args[++i];
  else if (a === '--since') opts.since = args[++i];
  else if (a === '--sort') opts.sort = args[++i];
  else if (a === '--regex') opts.regex = true;
  else if (a === '--case-sensitive') opts.caseSensitive = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--help' || a === '-h') usage(0);
  else usage(1, `Unknown arg: ${a}`);
}

if (!opts.query) usage(1, 'Missing --query');
if (!Number.isFinite(opts.limit) || opts.limit < 1) usage(1, '--limit must be >= 1');
if (!Number.isFinite(opts.before) || opts.before < 0) usage(1, '--before must be >= 0');
if (!Number.isFinite(opts.after) || opts.after < 0) usage(1, '--after must be >= 0');
if (!['all', 'user', 'assistant'].includes(opts.role)) usage(1, '--role must be all, user, or assistant');
if (!['all', 'claude', 'codex'].includes(opts.source)) usage(1, '--source must be all, claude, or codex');
if (!['newest', 'oldest', 'file'].includes(opts.sort)) usage(1, '--sort must be newest, oldest, or file');
const sinceTime = opts.since ? parseSince(opts.since) : null;
if (opts.since && sinceTime == null) usage(1, '--since must be today, Nd, or YYYY-MM-DD');
const queryRegex = opts.regex ? compileRegex(opts.query, opts.caseSensitive) : null;

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
  ...(opts.caseSensitive ? [] : ['-i']),
  ...(opts.regex ? [] : ['--fixed-strings']),
  '--files-with-matches',
  '--glob',
  '*.jsonl',
  opts.query,
  ...roots,
], { encoding: 'utf8' });

if (rg.status === 2) {
  const detail = rg.stderr.trim() ? `\n${rg.stderr.trim()}` : '';
  usage(1, `Invalid ${opts.regex ? 'regex' : 'query'} for ripgrep.${detail}`);
}

const files = rg.status === 0 ? rg.stdout.trim().split('\n').filter(Boolean) : [];
const matches = [];
const q = opts.caseSensitive ? opts.query : opts.query.toLowerCase();

for (const file of files) {
  const source = file.includes('/.codex/') ? 'codex' : 'claude';
  const messages = parseMessages(file, source);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (opts.role !== 'all' && msg.role !== opts.role) continue;
    const haystack = opts.caseSensitive ? msg.text : msg.text.toLowerCase();
    if (opts.regex ? !queryRegex.test(msg.text) : !haystack.includes(q)) continue;
    const time = timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? fs.statSync(file).mtimeMs;
    if (sinceTime != null && time < sinceTime) continue;
    matches.push({
      source,
      id: sessionId(file),
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

if (opts.sort === 'newest') matches.sort((a, b) => b.time - a.time);
else if (opts.sort === 'oldest') matches.sort((a, b) => a.time - b.time);
const limited = matches.slice(0, opts.limit);

if (opts.json) {
  console.log(JSON.stringify({ query: opts.query, regex: opts.regex, rawFilesWithHits: files.length, totalMatches: matches.length, count: limited.length, matches: limited }, null, 2));
} else {
  console.log(`query=${JSON.stringify(opts.query)}${opts.regex ? ' regex=true' : ''} raw_files_with_hits=${files.length} total_message_matches=${matches.length} shown=${limited.length} sort=${opts.sort}${opts.since ? ` since=${opts.since}` : ''}${opts.caseSensitive ? ' case_sensitive=true' : ''}`);
  limited.forEach((m, idx) => {
    console.log(`\n[${idx + 1}] ${m.source} id=${m.id} idx=${m.index} ts=${m.timestamp ?? ''}`);
    console.log(`path=${m.path}`);
    for (const b of m.before) console.log(`  before ${b.role}: ${truncate(b.text, 180)}`);
    console.log(`  MATCH ${m.match.role}: ${truncate(m.match.text, 300)}`);
    for (const a of m.after) console.log(`  after  ${a.role}: ${truncate(a.text, 180)}`);
  });
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

function sessionId(file) {
  return path.basename(file, '.jsonl');
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

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('Usage: sessions-grep.mjs --query TEXT [--regex] [--limit N] [--before N] [--after N] [--role user|assistant|all] [--source claude|codex|all] [--since today|7d|YYYY-MM-DD] [--sort newest|oldest|file] [--case-sensitive] [--json]');
  process.exit(code);
}

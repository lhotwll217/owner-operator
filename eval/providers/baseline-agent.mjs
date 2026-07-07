// Promptfoo provider: the sessions-grep-native BASELINE — Claude Code headless with the
// vendored session-grep script over the same fixture transcripts Owner Operator reads.
// Adapted from session-grep's eval provider (the proven pattern); one arm only.
//
// This is the issue-#31 control: a normal coding harness pointed at the transcripts with
// a good grep. OO must match its correctness and ideally beat its spend.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SANDBOX = path.join(os.tmpdir(), 'oo-eval-sandbox');
const GREP_BIN = path.join(repoRoot, '.agents', 'skills', 'sessions-grep', 'vendor', 'session-grep.mjs');

// Both arms read the same sandbox; seeding is idempotent and providers load before any
// test runs, so a double seed (this + oo-agent.mjs) just re-stamps timestamps.
const seed = spawnSync('npx', ['tsx', path.join(repoRoot, 'eval', 'seed', 'build-fixture-home.mjs')], { cwd: repoRoot, encoding: 'utf8' });
if (seed.status !== 0) throw new Error(`fixture seed failed: ${seed.stderr}`);

const SYSTEM_PROMPT = `You answer questions about past AI coding sessions recorded as JSONL transcripts under ./transcripts (claude/ and codex/ subdirs; the search tool handles both formats transparently).

Search them with the session-grep tool:
  node ${GREP_BIN} --query TEXT --root transcripts [flags]
Flags: --any (multi-word query: matches ANY word, ranked by words matched), --regex, --limit N (default 20), --before N / --after N (context messages around each hit), --role user|assistant|all, --since today|Nd|YYYY-MM-DD, --sort newest|oldest, --max-chars N (output budget, default 8000), --json.

Browse modes (no --query needed):
  --overview                    one-line digest per session: id, dates, sizes, opening prompt
  --skim SESSION_ID_PREFIX      the conversation of ONE session, sampled to fit the budget
  --session ID_PREFIX --at N    the exact messages around a hit's idx=N

Strategy: for broad questions start with --overview, then --skim the right session; verify key claims with targeted probes. For fact questions use --any for multi-word searches or a single rare term. The raw .jsonl files are large and noisy; do not cat/Read them wholesale.

The transcripts are your ONLY source of truth. Do not answer from your own memory or any other files. In the questions, "we"/"I" refer to the user and agent INSIDE those transcripts, not to you.

Your working directory IS the sandbox: transcripts are at ./transcripts. Use relative paths only. Your search commands are pre-approved — run them directly and never ask for permission.

Answer factually and concisely, citing which session (file id) the answer came from. If you cannot find the answer in the transcripts, say so plainly rather than guessing.`;

const BASE_TOOLS = 'Bash(rg*),Bash(grep*),Bash(cat*),Bash(head*),Bash(tail*),Bash(wc*),Bash(sed*),Bash(awk*),Bash(jq*),Bash(ls*),Bash(find*),Bash(xargs*),Bash(sort*),Bash(uniq*),Bash(cut*),Bash(tr*)';
const ALLOWED = `${BASE_TOOLS},Bash(node ${GREP_BIN}*),Bash(node .agents/skills/sessions-grep/vendor/session-grep.mjs*)`;
const DISALLOWED = 'Task,WebSearch,WebFetch,TodoWrite,Write,Edit,MultiEdit,NotebookEdit,Skill';

const runStamp = process.env.OO_EVAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export default class BaselineAgentProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.model = this.config.model ?? process.env.EVAL_MODEL ?? 'claude-sonnet-5';
    this.providerId = options.id ?? `baseline:${this.model}`;
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const maxTurns = this.config.maxTurns ?? 25;
    const maxBudgetUsd = this.config.maxBudgetUsd ?? 1.0;
    const timeoutMs = this.config.timeoutMs ?? 15 * 60 * 1000;
    const caseId = context?.vars?.id ?? 'case';

    const args = [
      '-p', prompt,
      '--model', this.model,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', String(maxTurns),
      '--max-budget-usd', String(maxBudgetUsd),
      '--append-system-prompt', SYSTEM_PROMPT,
      '--allowedTools', ALLOWED,
      '--disallowedTools', DISALLOWED,
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--setting-sources', '',
    ];

    const { lines, timedOut, spawnError, stderrTail } = await runClaude(args, timeoutMs);

    const toolCalls = [];
    let toolResultChars = 0;
    let result = null;
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'assistant') {
        for (const block of obj.message?.content ?? []) {
          if (block.type === 'tool_use') toolCalls.push({ name: block.name, input: compactInput(block.input) });
        }
      } else if (obj.type === 'user') {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') toolResultChars += JSON.stringify(block.content ?? '').length;
          }
        }
      } else if (obj.type === 'result') {
        result = obj;
      }
    }

    const logDir = path.join(repoRoot, 'eval', 'results', 'logs', runStamp);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${slug(caseId)}.baseline.${this.model}.jsonl`);
    fs.writeFileSync(logFile, lines.join('\n') + '\n');

    if (!result) {
      return {
        error: spawnError ?? (timedOut ? `claude run timed out after ${timeoutMs}ms` : `claude run produced no result envelope; stderr: ${stderrTail || '(empty)'}`),
        output: '',
        metadata: { arm: 'baseline', toolCalls, toolResultChars, logFile, stderrTail },
      };
    }

    const u = result.usage ?? {};
    const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const summary = {
      arm: 'baseline',
      caseId,
      model: this.model,
      costUsd: result.total_cost_usd ?? 0,
      tokensTotal: promptTokens + (u.output_tokens ?? 0),
      tokensUncached: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
      tokensCacheRead: u.cache_read_input_tokens ?? 0,
      tokensOutput: u.output_tokens ?? 0,
      numTurns: result.num_turns ?? 0,
      durationMs: result.duration_ms ?? 0,
      toolCallCount: toolCalls.length,
      toolResultChars,
      subtype: result.subtype,
      logFile: path.relative(repoRoot, logFile),
    };
    fs.appendFileSync(path.join(logDir, 'summary.jsonl'), JSON.stringify({ ...summary, toolCalls }) + '\n');

    return {
      output: result.result ?? '',
      tokenUsage: { total: summary.tokensTotal, prompt: promptTokens, completion: summary.tokensOutput, cached: summary.tokensCacheRead },
      cost: summary.costUsd,
      metadata: { ...summary, toolCalls },
    };
  }
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: SANDBOX, env: process.env });
    let buf = '';
    let stderr = '';
    const lines = [];
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      spawnError = String(err);
      clearTimeout(timer);
      resolve({ lines, timedOut, spawnError, stderrTail: stderr.slice(-2000) });
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 100000) stderr = stderr.slice(-50000);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (buf.trim()) lines.push(buf);
      resolve({ lines, timedOut, spawnError, stderrTail: stderr.slice(-2000) });
    });
  });
}

function compactInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + `…[${v.length} chars]` : v;
  }
  return out;
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60);
}

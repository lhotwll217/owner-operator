// Promptfoo provider: runs Owner Operator headless (`oo "question"`) as the eval
// subject, against the seeded fixture sandbox (transcripts + OO_HOME with a populated
// threads db). Behavior capture comes from OO_TRACE: one NDJSON line per tool
// call/result and per assistant turn (usage + cost) — parsed into metadata.toolCalls
// and token/cost totals so asserts and compare.mjs read both arms the same way.
//
// The sandbox is rebuilt once per eval process so fixture timestamps are fresh
// relative to "now" (activity windows behave identically on every run).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SANDBOX = path.join(os.tmpdir(), 'oo-eval-sandbox');
const OO_HOME = path.join(SANDBOX, 'home');

// One rebuild per eval process: providers are instantiated per arm, so stamp on the
// module, not the instance.
const seed = spawnSync('npx', ['tsx', path.join(repoRoot, 'eval', 'seed', 'build-fixture-home.mjs')], { cwd: repoRoot, encoding: 'utf8' });
if (seed.status !== 0) throw new Error(`fixture seed failed: ${seed.stderr}`);

const runStamp = process.env.OO_EVAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export default class OoAgentProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.providerId = options.id ?? 'oo-agent';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const timeoutMs = this.config.timeoutMs ?? 10 * 60 * 1000;
    const caseId = context?.vars?.id ?? 'case';
    const logDir = path.join(repoRoot, 'eval', 'results', 'logs', runStamp);
    fs.mkdirSync(logDir, { recursive: true });
    const traceFile = path.join(logDir, `${slug(caseId)}.oo.trace.ndjson`);
    fs.rmSync(traceFile, { force: true });

    const started = Date.now();
    const { stdout, stderr, timedOut, spawnError } = await runOo(prompt, traceFile, timeoutMs);
    const durationMs = Date.now() - started;

    // Trace accounting: tool calls + per-turn usage from the OO_TRACE stream.
    const toolCalls = [];
    let toolResultChars = 0;
    let turns = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };
    for (const line of fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split('\n') : []) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.event === 'tool_call') toolCalls.push({ name: ev.tool, input: compactInput(ev.args) });
      else if (ev.event === 'tool_result') toolResultChars += ev.resultChars ?? 0;
      else if (ev.event === 'turn') {
        turns++;
        usage.input += ev.usage?.input ?? 0;
        usage.output += ev.usage?.output ?? 0;
        usage.cacheRead += ev.usage?.cacheRead ?? 0;
        usage.total += ev.usage?.totalTokens ?? 0;
        usage.cost += ev.usage?.cost?.total ?? 0;
      }
    }

    if (spawnError || timedOut || !stdout.trim()) {
      return {
        error: spawnError ?? (timedOut ? `oo run timed out after ${timeoutMs}ms` : `oo produced no output; stderr: ${stderr.slice(-2000) || '(empty)'}`),
        output: stdout,
        metadata: { arm: 'owner-operator', toolCalls, toolResultChars, traceFile },
      };
    }

    const summary = {
      arm: 'owner-operator',
      caseId,
      costUsd: usage.cost,
      tokensTotal: usage.total,
      tokensUncached: usage.input + usage.output,
      tokensCacheRead: usage.cacheRead,
      tokensOutput: usage.output,
      numTurns: turns,
      durationMs,
      toolCallCount: toolCalls.length,
      toolResultChars,
      traceFile: path.relative(repoRoot, traceFile),
    };
    fs.appendFileSync(path.join(logDir, 'summary.jsonl'), JSON.stringify({ ...summary, toolCalls }) + '\n');

    return {
      output: stdout.trim(),
      tokenUsage: { total: usage.total, prompt: usage.input + usage.cacheRead, completion: usage.output, cached: usage.cacheRead },
      cost: usage.cost,
      metadata: { ...summary, toolCalls },
    };
  }
}

function runOo(prompt, traceFile, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(path.join(repoRoot, 'oo'), [prompt], {
      cwd: repoRoot,
      env: { ...process.env, OO_HOME, OO_TRACE: traceFile, OO_DAEMON: '0' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      spawnError = String(err);
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, spawnError });
    });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, spawnError });
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

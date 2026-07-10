// Shared runner for both eval arms. Each arm runs the SAME `oo` binary against the SAME
// seeded fixture sandbox and the SAME model — behavior captured identically from OO_TRACE
// (one NDJSON line per tool call/result and per assistant turn). The arms differ by exactly
// one thing: the naive arm sets OO_EVAL_BASELINE_PROMPT, which swaps OO's prompt+tools for a
// generic session-search agent (see src/agent/agent.ts). Same framework + same model =
// the tool-call/token deltas are attributable to OO's composition, nothing else.
//
// Seeding runs once per eval process (this module is a singleton), so the two providers
// importing it don't rebuild the sandbox against each other mid-run.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SANDBOX = path.join(os.tmpdir(), 'oo-eval-sandbox');
const OO_HOME = path.join(SANDBOX, 'home');
const DISCOVERY = path.join(OO_HOME, 'daemon.json');

await stopRecordedEvalDaemon();
const seed = spawnSync('npx', ['tsx', path.join(repoRoot, 'eval', 'seed', 'build-fixture-home.mjs')], { cwd: repoRoot, encoding: 'utf8' });
if (seed.status !== 0) throw new Error(`fixture seed failed: ${seed.stderr}`);
const evalDaemon = await startManagedEvalDaemon();
process.once('exit', () => {
  if (evalDaemon.exitCode === null) evalDaemon.kill('SIGTERM');
});

const runStamp = process.env.OO_EVAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Build a promptfoo provider class for one arm. `arm` labels the metadata + logs; `env`
 *  is merged into the `oo` subprocess environment (the naive arm sets the baseline prompt). */
export function makePiAgentProvider({ arm, env = {} }) {
  return class PiAgentProvider {
    constructor(options = {}) {
      this.config = options.config ?? {};
      this.providerId = options.id ?? `${arm}-agent`;
    }

    id() {
      return this.providerId;
    }

    async callApi(prompt, context) {
      const timeoutMs = this.config.timeoutMs ?? 10 * 60 * 1000;
      const caseId = context?.vars?.id ?? 'case';
      const logDir = path.join(repoRoot, 'eval', 'results', 'logs', runStamp);
      fs.mkdirSync(logDir, { recursive: true });
      const traceFile = path.join(logDir, `${slug(caseId)}.${arm}.trace.ndjson`);
      fs.rmSync(traceFile, { force: true });

      const started = Date.now();
      const { stdout, stderr, timedOut, spawnError } = await runOo(prompt, traceFile, timeoutMs, env);
      const durationMs = Date.now() - started;

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
          metadata: { arm, toolCalls, toolResultChars, traceFile },
        };
      }

      const summary = {
        arm,
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
  };
}

function runOo(prompt, traceFile, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(path.join(repoRoot, 'oo'), [prompt], {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv, OO_HOME, OO_TRACE: traceFile },
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

async function stopRecordedEvalDaemon() {
  let info;
  try { info = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8')); } catch { return; }
  if (!await daemonIdentityMatches(info)) {
    fs.rmSync(DISCOVERY, { force: true });
    return;
  }
  try { process.kill(info.pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!await daemonIdentityMatches(info)) return;
    await delay(50);
  }
  throw new Error(`prior eval daemon ${info.pid} did not stop`);
}

async function startManagedEvalDaemon() {
  const logPath = path.join(SANDBOX, 'daemon.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'eval-daemon.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, OO_HOME },
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  child.unref();

  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`eval daemon exited before readiness; inspect ${logPath}`);
    }
    let info;
    try { info = JSON.parse(fs.readFileSync(DISCOVERY, 'utf8')); } catch { /* still starting */ }
    if (info && await daemonReady(info)) return child;
    await delay(50);
  }
  child.kill('SIGTERM');
  throw new Error(`eval daemon did not become ready; inspect ${logPath}`);
}

async function daemonIdentityMatches(info) {
  if (!info || !Number.isInteger(info.port) || !Number.isInteger(info.pid) || !info.authToken) return false;
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.authToken}` },
      signal: AbortSignal.timeout(250),
    });
    if (!healthResponse.ok) return false;
    return (await healthResponse.json()).pid === info.pid;
  } catch {
    return false;
  }
}

async function daemonReady(info) {
  if (!await daemonIdentityMatches(info)) return false;
  try {
    const readyResponse = await fetch(`http://127.0.0.1:${info.port}/ready`, {
      headers: { authorization: `Bearer ${info.authToken}` },
      signal: AbortSignal.timeout(250),
    });
    if (!readyResponse.ok) return false;
    return (await readyResponse.json()).ready === true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

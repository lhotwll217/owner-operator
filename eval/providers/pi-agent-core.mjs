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
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evalSandboxPath,
  evalSandboxUserPaths,
  sanitizeEvalDiagnosticText,
  sanitizeEvalDiagnosticValue,
  sanitizeEvalSessionTrace,
  sanitizeEvalWorkerOutput,
} from '../sandbox.mjs';
import { normalizeBehavioralTrialResult } from './behavioral-result.mjs';
import { DEFAULT_GRADER_MODEL, DEFAULT_GRADER_REASONING } from './codex-grader.mjs';
import { readGitProvenance } from './git-provenance.mjs';
import { loadEvalModelSettings } from './model-settings.mjs';
import { readFatalModelError } from './trace-errors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const tsxLoaderPath = fileURLToPath(import.meta.resolve('tsx'));
const runStamp = process.env.OO_EVAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = evalSandboxPath(runStamp);
const OO_HOME = path.join(SANDBOX, 'home');
const RETRIEVAL_USER = evalSandboxUserPaths(SANDBOX);
const DISCOVERY = path.join(OO_HOME, 'daemon.json');
const SUBJECT_TRANSPORT = 'sse';
const logDir = path.join(repoRoot, 'eval', 'results', 'logs', runStamp);
const evalModelSettings = loadEvalModelSettings(repoRoot);
let invocationSequence = 0;
let fatalRunError = null;
let evalDaemon = null;
let retrievalSetup = null;

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(RETRIEVAL_USER.userHome, { recursive: true });
fs.mkdirSync(RETRIEVAL_USER.tempDir, { recursive: true });
process.once('exit', () => {
  if (evalDaemon?.exitCode === null) evalDaemon.kill('SIGTERM');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const runManifest = buildRunManifest();
const manifestFile = path.join(logDir, 'manifest.json');
if (fs.existsSync(manifestFile)) {
  throw new Error(`eval run id already exists: ${runStamp}; choose a fresh OO_EVAL_RUN_ID`);
}
fs.writeFileSync(manifestFile, JSON.stringify(runManifest, null, 2) + '\n');

/** Build a promptfoo provider class for one arm. `arm` labels the metadata + logs; `env`
 *  is merged into the `oo` subprocess environment (the naive arm sets the baseline prompt). */
export function makePiAgentProvider({ arm, env = {}, profile = 'retrieval' }) {
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
      const invocationId = `${String(++invocationSequence).padStart(3, '0')}-${randomUUID().slice(0, 8)}`;
      const baseName = `${slug(caseId)}.${arm}.${invocationId}`;
      const traceFile = path.join(logDir, `${baseName}.trace.ndjson`);

      if (fatalRunError) {
        const error = `eval circuit open after fatal model error: ${fatalRunError}`;
        fs.writeFileSync(traceFile, JSON.stringify({ event: 'provider_error', error }) + '\n');
        fs.writeFileSync(path.join(logDir, `${baseName}.stdout.txt`), '');
        fs.writeFileSync(path.join(logDir, `${baseName}.stderr.txt`), error + '\n');
        return {
          error,
          output: '',
          metadata: {
            arm,
            caseId,
            invocationId,
            runId: runStamp,
            manifestHash: runManifest.manifestHash,
            modelLabel: runManifest.modelLabel,
            sessionId: null,
            sessionTraceFile: null,
            toolCalls: [],
            toolExecutions: [],
            toolResultChars: 0,
            traceFile: path.relative(repoRoot, traceFile),
            costUsd: 0,
            tokensTotal: 0,
            tokensUncached: 0,
            tokensCacheRead: 0,
            tokensOutput: 0,
            numTurns: 0,
            durationMs: 0,
            toolCallCount: 0,
            providerError: error,
          },
        };
      }

      if (profile === 'behavioral') {
        return runBehavioralTrial({
          arm,
          prompt,
          context,
          caseId,
          invocationId,
          baseName,
          traceFile,
          timeoutMs,
        });
      }

      await ensureRetrievalHarness();

      const started = Date.now();
      const { stdout, stderr, timedOut, spawnError } = await runOo(prompt, traceFile, timeoutMs, env);
      const durationMs = Date.now() - started;
      fs.writeFileSync(path.join(logDir, `${baseName}.stdout.txt`), stdout);
      fs.writeFileSync(path.join(logDir, `${baseName}.stderr.txt`), stderr);

      const toolExecutions = [];
      const executionById = new Map();
      let toolResultChars = 0;
      let turns = 0;
      const usage = { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };
      for (const line of fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split('\n') : []) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === 'tool_call') {
          const execution = {
            id: ev.id,
            name: ev.tool,
            input: compactInput(ev.args),
            isError: null,
            resultChars: null,
          };
          toolExecutions.push(execution);
          executionById.set(ev.id, execution);
        } else if (ev.event === 'tool_result') {
          toolResultChars += ev.resultChars ?? 0;
          const execution = executionById.get(ev.id);
          if (execution) {
            execution.isError = Boolean(ev.isError);
            execution.resultChars = ev.resultChars ?? 0;
          }
        }
        else if (ev.event === 'turn') {
          turns++;
          usage.input += ev.usage?.input ?? 0;
          usage.output += ev.usage?.output ?? 0;
          usage.cacheRead += ev.usage?.cacheRead ?? 0;
          usage.total += ev.usage?.totalTokens ?? 0;
          usage.cost += ev.usage?.cost?.total ?? 0;
        }
      }
      const toolCalls = toolExecutions.map(({ name, input }) => ({ name, input }));
      const sessionId = /\[oo\] session ([A-Za-z0-9-]+)/.exec(stderr)?.[1] ?? null;
      const modelLabel = /\[oo\]\s+([^·\n]+?)\s+·/.exec(stderr)?.[1]?.trim() ?? null;
      const sessionTraceFile = copySessionTrace(sessionId, path.join(logDir, `${baseName}.session.jsonl`));
      const modelError = readFatalModelError(traceFile, sessionTraceFile);
      if (modelError) fatalRunError = modelError;
      const commonMetadata = {
        arm,
        caseId,
        invocationId,
        runId: runStamp,
        manifestHash: runManifest.manifestHash,
        modelLabel,
        sessionId,
        sessionTraceFile: sessionTraceFile ? path.relative(repoRoot, sessionTraceFile) : null,
        toolCalls,
        toolExecutions,
        toolResultChars,
        traceFile: path.relative(repoRoot, traceFile),
      };

      const summary = {
        ...commonMetadata,
        costUsd: usage.cost,
        tokensTotal: usage.total,
        tokensUncached: usage.input + usage.output,
        tokensCacheRead: usage.cacheRead,
        tokensOutput: usage.output,
        numTurns: turns,
        durationMs,
        toolCallCount: toolExecutions.length,
      };
      fs.appendFileSync(path.join(logDir, 'summary.jsonl'), JSON.stringify(summary) + '\n');

      const providerError = modelError ?? spawnError ??
        (timedOut ? `oo run timed out after ${timeoutMs}ms` : null) ??
        (!stdout.trim() ? `oo produced no output; stderr: ${stderr.slice(-2000) || '(empty)'}` : null) ??
        (modelLabel !== runManifest.modelLabel
          ? `model drift: manifest=${runManifest.modelLabel}, invocation=${modelLabel ?? 'unknown'}`
          : null);
      if (providerError) {
        return {
          error: providerError,
          output: stdout,
          metadata: { ...summary, providerError },
        };
      }

      return {
        output: stdout.trim(),
        tokenUsage: { total: usage.total, prompt: usage.input + usage.cacheRead, completion: usage.output, cached: usage.cacheRead },
        cost: usage.cost,
        metadata: summary,
      };
    }
  };
}

async function runBehavioralTrial({
  arm,
  prompt,
  context,
  caseId,
  invocationId,
  baseName,
  traceFile,
  timeoutMs,
}) {
  const started = Date.now();
  const vars = context?.vars ?? {};
  const behaviorProfile = vars.behaviorProfile
    ?? (vars.shouldMarkDone !== undefined ? 'mark-done' : null);
  if (!['mark-done', 'delegation-selection'].includes(behaviorProfile)) {
    throw new Error(`unsupported behavioral profile: ${behaviorProfile ?? 'missing'}`);
  }
  const trialRoot = evalSandboxPath(`${runStamp}-${invocationId}`);
  const ownerOoHome = process.env.OO_HOME ?? path.join(homedir(), '.owner-operator');
  const sourcePiAgentDir = process.env.OO_BEHAVIOR_EVAL_PI_SOURCE?.trim()
    || path.join(ownerOoHome, 'pi');
  let sandbox;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError = null;
  let payload = null;
  let preservedDiagnostics = null;

  try {
    sandbox = evalSandboxUserPaths(trialRoot);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
    fs.mkdirSync(sandbox.taskCwd, { recursive: true });
    fs.mkdirSync(sandbox.tempDir, { recursive: true });
    const trialInput = {
      version: 1,
      caseId,
      behaviorProfile,
      parentContext: prompt,
      ...(behaviorProfile === 'mark-done' ? {
        result: vars.result,
        shouldMarkDone: vars.shouldMarkDone,
        childSessionId: vars.childSessionId,
        sentinelSessionId: vars.sentinelSessionId,
      } : {
        behaviorClaim: vars.behaviorClaim,
        behaviorExpected: vars.behaviorExpected,
        harnessRoster: vars.harnessRoster,
        harnessDetails: vars.harnessDetails,
        baselineCandidate: vars.baselineCandidate,
        approvedBaseline: vars.approvedBaseline,
      }),
      timeoutMs,
      sourcePiAgentDir,
      protectedOwnerPaths: [ownerOoHome, path.join(repoRoot, 'eval')],
      modelSettings: { ...evalModelSettings.settings, transport: SUBJECT_TRANSPORT },
    };
    ({ stdout, stderr, timedOut, spawnError } = await spawnBehavioralWorker(
      trialInput,
      sandbox,
      timeoutMs,
    ));
    payload = parseBehavioralPayload(stdout);
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }

  const diagnosticRedactions = [trialRoot, sourcePiAgentDir, ownerOoHome];
  const safeStdout = sanitizeEvalWorkerOutput(stdout, diagnosticRedactions);
  const safeStderr = sanitizeEvalDiagnosticText(stderr, diagnosticRedactions);
  fs.writeFileSync(path.join(logDir, `${baseName}.stdout.txt`), safeStdout);
  fs.writeFileSync(path.join(logDir, `${baseName}.stderr.txt`), safeStderr);
  if (payload?.traceEvents) {
    fs.writeFileSync(traceFile, payload.traceEvents
      .map((event) => JSON.stringify(sanitizeEvalDiagnosticValue(event, diagnosticRedactions)))
      .join('\n') + '\n');
  } else {
    fs.writeFileSync(traceFile, JSON.stringify({
      event: 'provider_error',
      error: spawnError ?? (timedOut ? `behavioral trial timed out after ${timeoutMs}ms` : 'missing trial payload'),
    }) + '\n');
  }
  if (payload) {
    payload.sandbox = { ...payload.sandbox, diagnosticsRetained: true };
    const diagnosticPayload = {
      ...payload,
      sessionTrace: payload.sessionTrace ? '<stored separately after structural sanitization>' : null,
    };
    fs.writeFileSync(
      path.join(logDir, `${baseName}.diagnostic.json`),
      JSON.stringify(sanitizeEvalDiagnosticValue(diagnosticPayload, diagnosticRedactions), null, 2) + '\n',
    );
  }
  const sessionTraceFile = payload?.sessionTrace
    ? path.join(logDir, `${baseName}.session.jsonl`)
    : null;
  if (sessionTraceFile) {
    fs.writeFileSync(sessionTraceFile, sanitizeEvalSessionTrace(payload.sessionTrace, diagnosticRedactions));
  }
  const teardownVerified = Boolean(
    sandbox && !timedOut && !spawnError && payload?.sandbox?.daemonStopped === true
      && Number(payload?.sandbox?.leasesRemaining) === 0,
  );
  preservedDiagnostics = payload?.sandbox?.preservedDiagnostics ?? null;
  if (sandbox && !teardownVerified && !preservedDiagnostics) {
    // The worker could not report its fail-closed location (for example, SIGKILL). Remove
    // credential/config copies before preserving only this parent-authored diagnostic.
    for (const file of ['auth.json', 'settings.json', 'models.json']) {
      fs.rmSync(path.join(sandbox.ooHome, 'pi', file), { force: true });
    }
    fs.rmSync(sandbox.root, { recursive: true, force: true });
    preservedDiagnostics = path.join(sandbox.root, 'diagnostics');
    fs.mkdirSync(preservedDiagnostics, { recursive: true });
    fs.writeFileSync(path.join(preservedDiagnostics, 'diagnostic.json'), JSON.stringify({
      kind: 'behavioral-eval-worker-unavailable', caseId, invocationId, timedOut, spawnError,
    }, null, 2) + '\n');
  }

  const durationMs = Date.now() - started;
  const normalized = payload ? normalizeBehavioralTrialResult(payload) : null;
  const baseError = spawnError
    ?? (timedOut ? `behavioral trial timed out after ${timeoutMs}ms` : null)
    ?? (!payload ? 'behavioral trial produced no parseable result' : null);
  const modelDrift = normalized?.metadata.modelLabel && normalized.metadata.modelLabel !== runManifest.modelLabel
    ? `model drift: manifest=${runManifest.modelLabel}, invocation=${normalized.metadata.modelLabel}`
    : null;
  const providerError = baseError ?? normalized?.providerError ?? modelDrift;
  const metadata = {
    arm,
    profile: behaviorProfile,
    caseId,
    invocationId,
    runId: runStamp,
    manifestHash: runManifest.manifestHash,
    traceFile: path.relative(repoRoot, traceFile),
    sessionTraceFile: sessionTraceFile ? path.relative(repoRoot, sessionTraceFile) : null,
    durationMs,
    ...(normalized?.metadata ?? emptyBehavioralMetadata()),
    ...(preservedDiagnostics
      ? { preservedDiagnostics: sanitizeEvalDiagnosticText(preservedDiagnostics, [trialRoot]) }
      : {}),
  };
  fs.appendFileSync(path.join(logDir, 'summary.jsonl'), JSON.stringify(metadata) + '\n');

  if (providerError) {
    return { error: providerError, output: normalized?.output ?? '', metadata: { ...metadata, providerError } };
  }
  return {
    output: normalized.output,
    tokenUsage: {
      total: metadata.tokensTotal,
      prompt: metadata.tokensUncached - metadata.tokensOutput + metadata.tokensCacheRead,
      completion: metadata.tokensOutput,
      cached: metadata.tokensCacheRead,
    },
    cost: metadata.costUsd,
    metadata,
  };
}

function spawnBehavioralWorker(input, sandbox, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      '--import',
      tsxLoaderPath,
      path.join(repoRoot, 'eval', 'behavioral', 'run-scenario-trial.ts'),
      Buffer.from(JSON.stringify(input)).toString('base64url'),
    ], {
      cwd: sandbox.taskCwd,
      env: { ...sandbox.env, OO_EVAL_SANDBOX: sandbox.root },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs + 5_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { spawnError = String(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 && !spawnError) spawnError = `behavioral trial exited ${code ?? signal ?? 'unknown'}`;
      resolvePromise({ stdout, stderr, timedOut, spawnError });
    });
  });
}

function parseBehavioralPayload(stdout) {
  const match = [...String(stdout).matchAll(/^OO_BEHAVIOR_RESULT=([A-Za-z0-9_-]+)$/gm)].at(-1);
  if (!match) return null;
  return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
}

function emptyBehavioralMetadata() {
  return {
    trialVersion: null,
    modelLabel: null,
    sessionId: null,
    toolRoster: [],
    configuredToolRoster: [],
    toolExecutions: [],
    toolCalls: [],
    toolCallCount: 0,
    toolResultChars: 0,
    tokensTotal: 0,
    tokensUncached: 0,
    tokensCacheRead: 0,
    tokensOutput: 0,
    costUsd: 0,
    numTurns: 0,
    traceProblems: ["behavioral trial did not produce metadata"],
    completion: null,
    stateBefore: null,
    stateAfter: null,
    sandbox: null,
    harnessValid: false,
    harnessProblems: ['behavioral trial did not produce metadata'],
  };
}

async function ensureRetrievalHarness() {
  retrievalSetup ??= (async () => {
    await stopRecordedEvalDaemon();
    const seed = spawnSync('npx', ['tsx', path.join(repoRoot, 'eval', 'seed', 'build-fixture-home.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, OO_EVAL_SANDBOX: SANDBOX },
    });
    if (seed.status !== 0) throw new Error(`fixture seed failed: ${seed.stderr}`);
    evalDaemon = await startManagedEvalDaemon();
  })();
  await retrievalSetup;
}

function runOo(prompt, traceFile, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    // The shell launcher resolves to this same entry. Invoke it through Node's repository-owned
    // loader so tsx does not create an overlong IPC socket beneath the disposable TMPDIR.
    const child = spawn(process.execPath, [
      '--import',
      tsxLoaderPath,
      path.join(repoRoot, 'src', 'cli', 'oo.ts'),
      prompt,
    ], {
      cwd: repoRoot,
      env: {
        ...RETRIEVAL_USER.env,
        ...extraEnv,
        OO_HOME,
        OO_TRACE: traceFile,
        OO_EVAL_CWD: SANDBOX,
        OO_EVAL_READ_ONLY: '1',
        OO_EVAL_TRANSPORT: SUBJECT_TRANSPORT,
        OO_EVAL_DEFAULT_PROVIDER: evalModelSettings.settings.defaultProvider,
        OO_EVAL_DEFAULT_MODEL: evalModelSettings.settings.defaultModel,
        ...(evalModelSettings.settings.defaultThinkingLevel
          ? { OO_EVAL_DEFAULT_THINKING: evalModelSettings.settings.defaultThinkingLevel }
          : {}),
      },
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

function copySessionTrace(sessionId, destination, ooHome = OO_HOME) {
  if (!sessionId) return null;
  const root = path.join(ooHome, 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(root, { recursive: true }).map(String);
  } catch {
    return null;
  }
  const relative = files.find((file) => file.endsWith('.jsonl') && path.basename(file).includes(sessionId));
  if (!relative) return null;
  fs.writeFileSync(
    destination,
    sanitizeEvalSessionTrace(fs.readFileSync(path.join(root, relative), 'utf8'), [SANDBOX, ooHome]),
  );
  return destination;
}

function buildRunManifest() {
  const { settings, artifactPath: modelSettingsArtifact } = evalModelSettings;
  const artifactPaths = [...new Set([
    'package-lock.json',
    '.pi/settings.example.json',
    modelSettingsArtifact,
    'src/prompts/owner-operator.md',
    'src/agent/skills/session-search/SKILL.md',
    'src/agent/skills/session-search/scripts/session-search.mjs',
    'src/agent/skills/session-search/vendor/session-grep/session-grep.mjs',
    'src/agent/skills/session-search/vendor/session-grep/sources.mjs',
    'src/agent/skills/session-search/vendor/session-grep/adapters/_shared.mjs',
    'src/agent/skills/session-search/vendor/session-grep/adapters/claude.mjs',
    'src/agent/skills/session-search/vendor/session-grep/adapters/codex.mjs',
    'src/agent/skills/session-search/vendor/session-grep/adapters/pi.mjs',
    'eval/cases.yaml',
    'eval/fixtures/sessions.mjs',
    'eval/fixtures/naive-baseline-prompt.md',
    'eval/asserts/tool-use.mjs',
    'eval/asserts/efficiency.mjs',
    'eval/behavioral/contract.mjs',
    'eval/behavioral/scenario-operations.ts',
    'eval/behavioral/run-scenario-trial.ts',
    'eval/compare.mjs',
    'eval/loop.mjs',
    'eval/run-validity.mjs',
    'eval/sandbox.mjs',
    'eval/sandbox-user.ts',
    'eval/seed/build-fixture-home.mjs',
    'eval/providers/codex-grader.mjs',
    'eval/providers/behavioral-agent.mjs',
    'eval/providers/behavioral-result.mjs',
    'eval/providers/git-provenance.mjs',
    'eval/providers/model-settings.mjs',
    'eval/providers/noop-grader.mjs',
    'eval/providers/pi-agent-core.mjs',
    'eval/providers/trace-errors.mjs',
    'eval/promptfooconfig.yaml',
  ])];
  const artifacts = Object.fromEntries(artifactPaths.map((relative) => [
    relative,
    sha256(fs.readFileSync(path.join(repoRoot, relative))),
  ]));
  const git = readGitProvenance(repoRoot);
  const manifest = {
    runId: runStamp,
    createdAt: new Date().toISOString(),
    modelLabel: [settings.defaultProvider, settings.defaultModel].filter(Boolean).join('/'),
    modelSettingsArtifact,
    reasoningLevel: settings.defaultThinkingLevel ?? null,
    subjectTransport: SUBJECT_TRANSPORT,
    graderModel: process.env.EVAL_GRADER_MODEL ?? DEFAULT_GRADER_MODEL,
    graderReasoning: DEFAULT_GRADER_REASONING,
    piVersion: JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version,
    promptfooVersion: JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', 'promptfoo', 'package.json'), 'utf8')).version,
    ...git,
    artifacts,
  };
  return { ...manifest, manifestHash: sha256(JSON.stringify(manifest)) };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
  const logPath = path.join(logDir, 'daemon.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'eval-daemon.mjs')], {
    cwd: repoRoot,
    env: { ...RETRIEVAL_USER.env, OO_HOME },
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

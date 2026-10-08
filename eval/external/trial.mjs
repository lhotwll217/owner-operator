// One external-agent trial, run by eval/providers/pi-agent-core.mjs in its own process:
// createSandboxUser replaces process.env and hosts the daemon in-process, so the sandbox
// cannot share the Promptfoo process. The trial builds a `cli-driving` sandbox from the
// measured checkout, seeds the fixture sessions, puts an instrumented `oo` first on PATH,
// runs Promptfoo's native Codex or Claude Agent SDK provider, and tears everything down.
// It prints one OO_EXTERNAL_RESULT line: the sanitized output, trajectory, and CLI calls.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadApiProvider } from "promptfoo";
import { seedFixtureSessions } from "../seed/fixture-sessions.mjs";
import { ThreadDb } from "../../src/state/database.ts";
import { sanitizeEvalDiagnosticValue } from "../sandbox.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
export const SETTLED_SESSION_ID = "fx-aurora-release-settled";

export async function runExternalTrial(input, loadProvider = loadApiProvider) {
  const { createSandboxUser } = await import(pathToFileURL(join(input.checkout, "eval/sandbox-user.ts")).href);
  const neutralConfig = `${input.root}.settings`;
  mkdirSync(resolve(input.root, ".."), { recursive: true });
  writeFileSync(neutralConfig, input.harness === "codex" ? "" : "{}", { mode: 0o600 });
  const secrets = secretStrings(JSON.parse(readFileSync(input.credentialSource, "utf8")));
  const controller = new AbortController();
  const abort = (signal) => () => controller.abort(new Error(`received ${signal}`));
  const onTerm = abort("SIGTERM");
  const onInt = abort("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  const timer = setTimeout(() => controller.abort(new Error("external agent timeout")), input.timeoutMs);
  const problems = [];
  let sandbox;
  let response;
  let callsFile;
  let cliCalls = [];
  let teardown = null;
  try {
    sandbox = await createSandboxUser({
      profile: "cli-driving", root: input.root, allowLiveHarness: true,
      liveHarness: { harness: input.harness, credentialSource: input.credentialSource, configSource: neutralConfig },
      protectedOwnerPaths: [input.credentialSource, join(input.checkout, "eval"), resolve(here, "..")],
    });
    const seeded = seedFixtureSessions({ root: sandbox.root, ooHome: sandbox.ooHome });
    writeFileSync(sandbox.paths.sessionSources, JSON.stringify(seeded.sessionSources));
    writeFileSync(join(sandbox.ooHome, "settings.json"), JSON.stringify({ activeWindow: "14d" }));
    if (input.settledObligation) addSettledObligation(sandbox);
    const observed = await installObservedCli(input, sandbox);
    callsFile = observed.callsFile;
    const skill = readFileSync(join(input.checkout, "skills/owner-operator/SKILL.md"), "utf8");
    const prompt = `${input.prompt}\n\n<skill name="owner-operator">\n${skill}\n</skill>`;
    const provider = await loadProvider(input.harness === "codex" ? "openai:codex-sdk" : "anthropic:claude-agent-sdk", {
      options: { config: nativeConfig(input, sandbox.taskCwd, observed.env) },
    });
    response = await provider.callApi(prompt, { vars: {}, bustCache: true, prompt: { raw: prompt, label: "request" } }, {
      abortSignal: controller.signal,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (response.error) throw new Error(response.error);
    if (!response.sessionId || response.sessionId === "unknown") throw new Error("agent did not expose its session identity");
    if (typeof response.output !== "string" || !response.output.trim()) throw new Error("agent produced no answer");
  } catch (error) {
    problems.push(error.message);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    if (callsFile && existsSync(callsFile)) {
      try { cliCalls = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
      catch (error) { problems.push(`command evidence unreadable: ${error.message}`); }
    }
    if (sandbox) {
      try {
        teardown = await sandbox.close();
        if (!teardown.teardownVerified) problems.push("sandbox teardown unverified");
      } catch (error) { problems.push(`teardown failed: ${error.message}`); }
    }
    rmSync(neutralConfig, { force: true });
  }
  let harnessToolCalls = null;
  if (response && !problems.length) {
    try { harnessToolCalls = normalizeTools(input.harness, response).length; }
    catch (error) { problems.push(error.message); }
  }
  return sanitizeEvalDiagnosticValue({
    output: response?.output ?? "",
    tokenUsage: response?.tokenUsage ?? null,
    cost: response?.cost ?? null,
    metadata: {
      sessionId: response?.sessionId ?? null,
      toolExecutions: cliCalls.map(sharedExecution), ooCalls: cliCalls, harnessToolCalls,
      harnessValid: problems.length === 0, harnessProblems: problems,
      sandbox: teardown && { daemonStopped: teardown.daemonStopped, leasesRemaining: teardown.leasesRemaining },
    },
  }, [input.root, input.checkout, input.credentialSource, ...secrets]);
}

/** One recorded `oo` invocation in the shape asserts/tool-use.mjs grades every subject by, so the
 * external subjects are judged by the same behavior gate as the embedded Operator. The launcher
 * records argv, so the command is rebuilt from it rather than parsed back out of a shell line. */
function sharedExecution(call, index) {
  return {
    id: String(index),
    name: "bash",
    input: { command: ["oo", ...call.args].map(shellWord).join(" ") },
    isError: call.exitCode !== 0,
    resultChars: String(call.output ?? "").length,
    result: { content: [{ type: "text", text: String(call.output ?? "") }] },
  };
}

function shellWord(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Native provider options: the agent sees only the sandbox env, cwd, and named executable. */
export function nativeConfig(input, cwd, env) {
  if (input.harness === "codex") return {
    codex_path_override: input.executable,
    working_dir: cwd, model: input.model, model_reasoning_effort: input.effort,
    inherit_process_env: false, cli_env: env, persist_threads: false,
    skip_git_repo_check: true, sandbox_mode: "danger-full-access", approval_policy: "never",
    web_search_mode: "disabled",
    cli_config: { features: { skip_host_skill_discovery: true }, project_doc_max_bytes: 0 },
  };
  return {
    path_to_claude_code_executable: input.executable,
    working_dir: cwd, model: input.model, effort: input.effort, env, apiKeyRequired: false,
    setting_sources: [], strict_mcp_config: true, mcp: { servers: [] },
    extra_args: { "disable-slash-commands": null },
    tools: ["Bash", "Read", "Glob", "Grep"], custom_allowed_tools: ["Bash", "Read", "Glob", "Grep"],
    permission_mode: "bypassPermissions", allow_dangerously_skip_permissions: true,
    max_turns: 30, persist_session: false,
  };
}

/** The native providers' tool trajectories, normalized so a missing one fails the trial. */
export function normalizeTools(harness, response) {
  if (harness === "claude-code") {
    if (!Array.isArray(response.metadata?.toolCalls)) throw new Error("missing Claude tool trajectory");
    return response.metadata.toolCalls.map((tool, index) => ({
      id: tool.id ?? String(index), name: tool.name, input: tool.input,
      isError: tool.is_error === true, resultChars: JSON.stringify(tool.output ?? "").length,
    }));
  }
  const turn = JSON.parse(response.raw ?? "{}");
  if (!Array.isArray(turn.items)) throw new Error("missing Codex tool trajectory");
  return turn.items.filter((item) => item.type === "command_execution").map((item, index) => ({
    id: item.id ?? String(index), name: "shell", input: { command: item.command },
    isError: item.status !== "completed" || item.exit_code !== 0,
    resultChars: String(item.aggregated_output ?? "").length,
  }));
}

// A login shell can re-order PATH from the user's shell files, so the sandbox HOME's own
// files pin the launcher, and the trial refuses to start unless `oo` resolves to it.
async function installObservedCli(input, sandbox) {
  const bin = join(sandbox.root, "bin");
  mkdirSync(bin);
  const callsFile = join(sandbox.root, "commands.jsonl");
  const env = { ...sandbox.env, PATH: `${bin}:${sandbox.env.PATH}`, OO_PORT: String(sandbox.daemon.port) };
  const profile = `export PATH='${env.PATH.replaceAll("'", "'\\''")}'\n`;
  for (const file of [".zprofile", ".zshrc", ".bash_profile", ".bashrc"]) writeFileSync(join(sandbox.userHome, file), profile);
  copyFileSync(join(here, "cli-observer.mjs"), join(bin, "client.mjs"));
  const { SESSION_SEARCH_VALUE_FLAGS } = await import(pathToFileURL(join(input.checkout, "src/session-search/flags.mjs")).href);
  writeFileSync(join(bin, "connection.json"), JSON.stringify({
    cli: join(input.checkout, "src/cli/oo.ts"), loader: fileURLToPath(import.meta.resolve("tsx")),
    calls: callsFile, transcripts: join(sandbox.root, "transcripts/codex"),
    valueFlags: [...SESSION_SEARCH_VALUE_FLAGS], env,
  }));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, "oo"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bin, "client.mjs"))} "$@"\n`, { mode: 0o755 });
  const resolved = execFileSync(env.SHELL || "/bin/sh", ["-lc", "command -v oo"], { env, cwd: sandbox.taskCwd, encoding: "utf8" }).trim();
  if (resolved !== join(bin, "oo")) throw new Error("login shell does not resolve the selected checkout's oo launcher");
  return { callsFile, env };
}

// The shared fixture leaves aurora-weather PR #42 awaiting review; this later session settles
// it, so a correct "what needs me" answer must come from evidence rather than the stale row.
function addSettledObligation(sandbox) {
  const timestamp = new Date().toISOString();
  const file = join(sandbox.root, "transcripts/codex", `${SETTLED_SESSION_ID}.jsonl`);
  writeFileSync(file, [
    { type: "session_meta", timestamp, payload: { id: SETTLED_SESSION_ID, cwd: "/home/dev/projects/aurora-weather", originator: "codex_cli" } },
    { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [
      { type: "output_text", text: "aurora-weather PR #42 was reviewed and merged. FakeClock fix is on main, CI passed. No owner action remains on PR #42." },
    ] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const db = new ThreadDb(join(sandbox.ooHome, "state.db"));
  try {
    db.recordScan({ id: SETTLED_SESSION_ID, source: "codex", repo: "aurora-weather", project: "/home/dev/projects/aurora-weather",
      app: "Codex CLI", state: "idle", transcriptPath: file, createdAt: timestamp, lastMessageAt: timestamp, lastActiveAt: timestamp });
    db.appendModelDetails(SETTLED_SESSION_ID, { priority: 1, topic: "Aurora PR #42 merged", statusSummary: "PR #42 merged; no owner action remains." }, timestamp);
  } finally { db.close(); }
}

function secretStrings(value) {
  if (typeof value === "string") return value.length >= 12 ? [value] : [];
  return value && typeof value === "object" ? Object.values(value).flatMap(secretStrings) : [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
  const result = await runExternalTrial(input);
  process.stdout.write(`OO_EXTERNAL_RESULT=${Buffer.from(JSON.stringify(result)).toString("base64url")}\n`);
}

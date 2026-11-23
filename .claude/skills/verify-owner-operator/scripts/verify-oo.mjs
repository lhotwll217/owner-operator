#!/usr/bin/env node
// Live verification of Owner Operator on this Mac. Usage and proof contract: ../SKILL.md.
import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Each harness `oo runs delegate` accepts, the CLI whose presence means it is installed, and the
 * transcript format its child sessions are tracked under. */
const HARNESSES = {
  "claude-code": { bin: "claude", source: "claude" },
  codex: { bin: "codex", source: "codex" },
  cursor: { bin: "cursor-agent", source: "cursor" },
  opencode: { bin: "opencode", source: "opencode" },
  antigravity: { bin: "agy", source: "antigravity" },
};

/** The owner instructions file each role appends, and the boundary text that must follow it
 * (`delegatedChildTaskEnvelope` in src/agent-runs/acp-launcher.ts). */
const ROLES = {
  worker: { file: "delegated-worker-instructions.md", boundary: () => "Complete the work directly; do not launch further agents." },
  orchestrator: { file: "delegated-child-instructions.md", boundary: (childId) => `oo runs delegate --from-session ${childId}` },
};

/** What each turn asks of its child. `plain` runs on every installed harness; the others run on
 * --role-harness. The widget turn sleeps so the monitor admits the child while its run is live. */
const reply = (nonce) => `This is an Owner Operator verification turn. Reply with exactly ${nonce} and nothing else. Do not use tools.`;
const TURN_KINDS = {
  plain: { role: null, task: reply },
  worker: { role: "worker", task: reply },
  orchestrator: { role: "orchestrator", task: reply },
  widget: { role: null, task: (nonce) => `This is an Owner Operator verification turn. Run the shell command \`python3 -c "import time; time.sleep(45)"\` in the foreground and wait for it to exit, then reply with exactly ${nonce} and nothing else.` },
};
const FEATURES = ["doctor", "harness-turn", "session-tracking", "widget", "search", "roles", "daemon-e2e"];

/** Breakage the owner already knows about (Luke, 2026-11-23). A failing check that matches one,
 * including its `evidence` pattern when set, reports `known-gap` instead of `fail`; a passing one
 * reports the gap as possibly closed. */
const KNOWN_GAPS = [
  { id: "child-summary", check: "summary", text: "Finished delegated children get no status summary: enrichment skips done rows." },
  { id: "summary-1200", check: null, text: "Summaries see only the first 1,200 characters of a reply for sources other than Claude, Codex, and Pi.",
    unexercised: "Not observable live: only a summary shows the cut, and delegated children get none (child-summary)." },
  { id: "agentsview-opencode", check: "search", harness: "opencode", evidence: /backend=agentsview /, text: "agentsview v0.48.0 cannot find OpenCode 2.4 replies." },
  { id: "daemon-e2e", check: "daemon-e2e", evidence: /daemon did not become ready/, text: "Daemon e2e tests fail on main with \"daemon did not become ready\"." },
  { id: "role-file-silent", check: "role-file", text: "A missing role instructions file is skipped silently; the run gets no owner instructions." },
];

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "lost"]);
const STALE_WORKING_MS = 30 * 60_000;

const USAGE = `usage: verify-oo.mjs [--target installed|checkout] [--repo DIR] [options]

  --target installed     drive the global oo and the owner's daemon (default)
  --target checkout      start an isolated daemon from --repo (default: cwd) under a temp OO_HOME
  --harness a,b          per-harness turns only for these (default: every harness CLI on PATH)
  --role-harness h       harness for the worker, orchestrator, and widget turns (default claude-code)
  --from-session id      parent for every run (default: the product's caller detection)
  --timeout s            per-run timeout in seconds (default 300)
  --out dir              evidence directory (default ~/.owner-operator/verification/verify-oo-<stamp>)
  --e2e                  also run npm run test:e2e in the checkout
`;
const { values: opts } = parseArgs({
  options: {
    help: { type: "boolean", default: false },
    target: { type: "string", default: "installed" },
    repo: { type: "string" },
    harness: { type: "string" },
    "role-harness": { type: "string", default: "claude-code" },
    "from-session": { type: "string" },
    timeout: { type: "string", default: "300" },
    out: { type: "string" },
    e2e: { type: "boolean", default: false },
  },
});
if (opts.help) { process.stdout.write(USAGE); process.exit(0); }
if (!["installed", "checkout"].includes(opts.target)) throw new Error("--target is installed or checkout");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(opts.out ?? join(homedir(), ".owner-operator", "verification", `verify-oo-${stamp}`));
mkdirSync(out, { recursive: true });
const runTimeout = Number(opts.timeout);
const checks = [];
const record = (feature, check, harness, ok, evidence) => checks.push({ feature, check, harness, ok, evidence });
const save = (name, text) => writeFileSync(join(out, name), typeof text === "string" ? text : JSON.stringify(text, null, 2));
const log = (line) => process.stderr.write(`[verify-oo] ${line}\n`);

const env = { ...process.env };
delete env.OO_AGENT;
delete env.OO_AGENT_RUN_LEASE_ID;

/** Runs one `oo` command. A daemon that stops answering is retried for up to 2 minutes and logged
 * to daemon-stalls.log: a stall is evidence, and the check it delays still reports. */
let interrupted = false;
const inFlight = new Set();
async function oo(args, { allowFail = false, timeoutMs = 120_000 } = {}) {
  const stallDeadline = Date.now() + 120_000;
  for (;;) {
    if (interrupted) throw new Error("verification interrupted");
    try {
      const pending = execFileAsync(target.ooBin, args, { env, timeout: timeoutMs, maxBuffer: 64 << 20 });
      inFlight.add(pending.child);
      const { stdout, stderr } = await pending.finally(() => inFlight.delete(pending.child));
      return { code: 0, stdout, stderr };
    } catch (error) {
      const stderr = String(error.stderr ?? error.message);
      if (/cannot reach|did not become ready|ECONNREFUSED/i.test(stderr) && Date.now() < stallDeadline) {
        appendFileSync(join(out, "daemon-stalls.log"), `${new Date().toISOString()} oo ${args.slice(0, 3).join(" ")}: ${stderr.trim().slice(0, 300)}\n`);
        await sleep(5000);
        continue;
      }
      if (!allowFail) throw new Error(`oo ${args.join(" ")} failed: ${stderr}`);
      return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr };
    }
  }
}
const ooJson = async (args) => JSON.parse((await oo([...args, "--json"])).stdout);
const sql = async (query) => (await ooJson(["db", "query", query])).rows;
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

async function waitFor(read, ms, intervalMs = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() > deadline) return value;
    await sleep(intervalMs);
  }
}

async function health(ooHome) {
  const discovery = JSON.parse(readFileSync(join(ooHome, "daemon.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${discovery.port}/health`, { headers: { authorization: `Bearer ${discovery.authToken}` } });
  const { authToken: _redacted, ...body } = await response.json();
  return { pid: discovery.pid, ...body };
}

const execFileSyncText = (file, args) => execFileSync(file, args, { encoding: "utf8" }).trim();
const builtWidget = (root) => [join(root, "apps/widget/.build/release/oo-widget")].find(existsSync);
const installedRuntimeRoot = () => dirname(realpathSync(execFileSyncText("/usr/bin/which", ["oo"])));

async function freePort() {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

/** The isolated daemon gets a fresh state database and copies of the owner's onboarding, transcript
 * sources, model credentials, baselines, and role files, with the real HOME so harness logins and
 * transcript stores are the owner's. launchd manages only the default OO_HOME, so this daemon can
 * never restart the owner's (`launchdCanManageCurrentHome` in src/daemon/ensure.ts). */
async function startCheckoutDaemon(repo, checkout) {
  const realHome = join(homedir(), ".owner-operator");
  const root = mkdtempSync(join(tmpdir(), "oo-verify-"));
  const ooHome = join(root, "oo-home");
  Object.assign(checkout, { root, ooHome });
  mkdirSync(join(ooHome, "workspace"), { recursive: true });
  for (const name of ["onboarded.json", "session_sources.json", "session_hosts.json", "blacklist.json", "session-grep-sources.json"]) {
    if (existsSync(join(realHome, name))) copyFileSync(join(realHome, name), join(ooHome, name));
  }
  const settings = JSON.parse(readFileSync(join(realHome, "settings.json"), "utf8"));
  writeFileSync(join(ooHome, "settings.json"), JSON.stringify({ ...settings, activeWindow: "1h" }, null, 2));
  cpSync(join(realHome, "pi"), join(ooHome, "pi"), { recursive: true, filter: (path) => !path.startsWith(join(realHome, "pi", "sessions")) });
  if (existsSync(join(realHome, "delegated-baselines"))) cpSync(join(realHome, "delegated-baselines"), join(ooHome, "delegated-baselines"), { recursive: true });
  for (const { file } of Object.values(ROLES)) {
    if (existsSync(join(realHome, "workspace", file))) copyFileSync(join(realHome, "workspace", file), join(ooHome, "workspace", file));
  }
  env.OO_HOME = ooHome;
  env.OO_PORT = String(await freePort());
  const logFd = openSync(join(out, "daemon.log"), "a");
  const daemon = spawn(join(repo, "oo"), ["daemon"], { env, cwd: repo, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  checkout.daemon = daemon;
  let spawnError;
  daemon.once("error", (error) => { spawnError = error; });
  const ready = await waitFor(async () => {
    if (daemon.exitCode !== null || spawnError) return false;
    try { return (await health(ooHome)).pid === daemon.pid ? true : undefined; } catch { return undefined; }
  }, 300_000, 1000);
  if (!ready) throw new Error(spawnError ? `could not start ${join(repo, "oo")}: ${spawnError.message}` : `checkout daemon did not become ready; see ${join(out, "daemon.log")}`);
}

/** True when `pid` holds this home's state database open, so a recycled PID is never signalled. */
const holdsHome = (pid, ooHome) => execFileAsync("lsof", ["-a", "-p", String(pid), "-Fn"])
  .then(({ stdout }) => stdout.includes(join(ooHome, "state.db")), () => false);

const exited = (pid) => { try { process.kill(pid, 0); return undefined; } catch { return true; } };

/** Stops the spawned daemon and any replacement a later `oo` command started in the same home. */
async function stopCheckoutDaemon({ root, ooHome, daemon }) {
  if (!root) return;
  const leases = () => existsSync(join(ooHome, "agent-runs", "process-leases"))
    ? readdirSync(join(ooHome, "agent-runs", "process-leases")).filter((name) => name.endsWith(".json")) : [];
  const discovered = existsSync(join(ooHome, "daemon.json")) ? JSON.parse(readFileSync(join(ooHome, "daemon.json"), "utf8")).pid : undefined;
  const pids = new Set([daemon?.exitCode === null ? daemon.pid : undefined, discovered].filter(Boolean));
  const stopped = [];
  for (const pid of pids) {
    if (pid !== daemon?.pid && !(await holdsHome(pid, ooHome))) continue;
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    if (!(await waitFor(() => exited(pid), 20_000, 250))) process.kill(pid, "SIGKILL");
    stopped.push(pid);
  }
  const leftovers = (await execFileAsync("lsof", ["-t", "+D", ooHome]).catch((error) => ({ stdout: error.stdout ?? "" }))).stdout.split("\n").filter(Boolean);
  save("cleanup.json", { daemonPid: daemon?.pid, stopped, leasesLeft: leases(), processesLeft: leftovers });
  rmSync(root, { recursive: true, force: true });
}

async function launch(harness, task, role) {
  const args = ["runs", "delegate", "--harness", harness, "--no-wait", "--timeout", String(runTimeout), "--cwd", tmpdir()];
  if (role) args.push("--role", role);
  if (opts["from-session"]) args.push("--from-session", opts["from-session"]);
  args.push("--json", task);
  // A fresh isolated daemon rejects a parent session until its first scan has observed it. A
  // client timeout may still have created the run, so look for it before launching again.
  return await waitFor(async () => {
    const result = await oo(args, { allowFail: true });
    if (result.code === 0) return { run: JSON.parse(result.stdout) };
    if (/aborted due to timeout/i.test(result.stderr)) {
      const created = (await ooJson(["runs", "list"])).find((run) => run.task === task);
      if (created) return { run: created };
      appendFileSync(join(out, "daemon-stalls.log"), `${new Date().toISOString()} delegate ${harness} timed out with no run created; retrying\n`);
      return undefined;
    }
    if (/matches no session/i.test(result.stderr) && opts.target === "checkout") return undefined;
    return { error: result.stderr.trim() };
  }, 180_000, 5000) ?? { error: "delegate kept timing out or the parent session was never observed (daemon-stalls.log)" };
}

/** Polls every launched run to a terminal status, recording what /session-state showed for each
 * child while it ran: the widget's only source of rows. */
async function followRuns(launched) {
  const timeline = [];
  const deadline = Date.now() + (runTimeout + 120) * 1000;
  for (;;) {
    const live = launched.filter((item) => item.run && !TERMINAL.has(item.run.status));
    if (live.length === 0) break;
    if (Date.now() > deadline) {
      for (const item of live) await oo(["runs", "cancel", item.run.id], { allowFail: true });
      break;
    }
    for (const item of live) item.run = await ooJson(["runs", "get", item.run.id]);
    const rows = await ooJson(["session-state", "list"]);
    const ids = new Set(launched.map((item) => item.run?.childSessionId).filter(Boolean));
    timeline.push({
      at: new Date().toISOString(),
      runs: launched.filter((item) => item.run).map(({ run }) => ({ id: run.id, status: run.status, childSessionId: run.childSessionId })),
      childRows: rows.filter((row) => ids.has(row.id)).map(({ id, source, topic, section, depth, parentThreadId, state }) => ({ id, source, topic, section, depth, parentThreadId, state })),
    });
    const widgetTurn = launched.find((item) => item.kind === "widget" && item.run && !TERMINAL.has(item.run.status));
    if (widgetTurn && !widgetTurn.renderedWhileRunning && rows.some((row) => row.id === widgetTurn.run.childSessionId)) {
      widgetTurn.renderedWhileRunning = (await renderWidget()).stdout;
      save("widget-while-running.txt", widgetTurn.renderedWhileRunning);
    }
    await sleep(3000);
  }
  save("timeline.json", timeline);
  return timeline;
}

async function renderWidget() {
  if (!target.widgetBin) return { ok: null, stdout: "no built oo-widget binary for this target (apps/widget/.build/release/oo-widget)" };
  return await execFileAsync(target.widgetBin, ["--once"], { env })
    .then(({ stdout }) => ({ ok: true, stdout }), (error) => ({ ok: false, stdout: `${error.stdout}${error.stderr}` }));
}

async function threadEvidence(childId) {
  const [thread] = await sql(`select id, source, app, transcript_path, last_message_at from threads where id = ${quote(childId)}`);
  const [detail] = await sql(`select version, written_by, state, created_at from thread_details where thread_id = ${quote(childId)} order by version desc limit 1`);
  const [summary] = await sql(`select version, status_summary from thread_details where thread_id = ${quote(childId)} and written_by = 'model' and status_summary is not null order by version desc limit 1`);
  return { thread, detail, summary };
}

async function verifyTurn({ harness, kind, nonce, run, error, renderedWhileRunning }, timeline) {
  const label = kind === "plain" ? harness : `${harness}+${kind}`;
  const { role } = TURN_KINDS[kind];
  if (error) return record("harness-turn", "launch", label, false, `delegate refused: ${error}`);
  save(`run-${label}.json`, run);
  const replied = run.status === "completed" && (run.resultTail ?? "").includes(nonce);
  record("harness-turn", "reply", label, replied,
    `run ${run.id} status=${run.status} model=${run.model} resultTail=${JSON.stringify((run.resultTail ?? "").slice(-120))}${run.error ? ` error=${JSON.stringify(run.error).slice(0, 300)}` : ""}`);
  if (!run.childSessionId) {
    if (run.status === "completed") record("session-tracking", "observed", label, false, "completed run reported no child session id");
    return;
  }
  const childId = run.childSessionId;

  const settled = await waitFor(async () => {
    const evidence = await threadEvidence(childId);
    return evidence.thread && evidence.detail && evidence.detail.state !== "working" ? evidence : undefined;
  }, 120_000) ?? await threadEvidence(childId);
  record("session-tracking", "observed", label, Boolean(settled.thread) && settled.thread.source === HARNESSES[harness].source,
    settled.thread ? `thread ${childId} source=${settled.thread.source} app=${settled.thread.app} transcript=${settled.thread.transcript_path}` : `no threads row for child ${childId} after 120s`);
  if (!settled.thread) return;
  record("session-tracking", "finished", label, Boolean(settled.detail) && settled.detail.state !== "working",
    `latest thread_details v${settled.detail?.version} by ${settled.detail?.written_by}: state=${settled.detail?.state} (working after the run ended means the transcript reader missed the reply)`);

  const transcriptReply = await waitFor(async () => {
    const result = await oo(["search", "--session", childId, "--query", nonce, "--role", "assistant", "--json"], { allowFail: true });
    if (result.code !== 0) return undefined;
    const hit = JSON.parse(result.stdout).matches?.find((match) => match.match?.role === "assistant");
    return hit ? hit.match.text : undefined;
  }, 60_000);
  record("session-tracking", "reply", label, Boolean(transcriptReply),
    transcriptReply ? `oo search --session ${childId} finds assistant text ${JSON.stringify(transcriptReply.slice(0, 120))}` : `no assistant message containing ${nonce} in the child transcript`);

  const summary = (await waitFor(async () => (await threadEvidence(childId)).summary, 60_000))?.status_summary;
  record("session-tracking", "summary", label, Boolean(summary),
    summary ? `status summary: ${JSON.stringify(summary.slice(0, 200))}` : "no model status summary 60s after the turn settled");

  const seen = timeline.flatMap((tick) => tick.childRows.filter((row) => row.id === childId));
  const finalRows = await ooJson(["session-state", "list"]);
  const finalRow = finalRows.find((row) => row.id === childId);
  const parent = run.parentThreadId;
  const parentVisible = parent && finalRows.some((row) => row.id === parent);
  // The transcript can settle one poll before the run turns terminal, so Working must show at least once, not on every poll.
  const nestedWhileRunning = (seen.length === 0 || seen.some((row) => row.section === "working"))
    && seen.every((row) => !parentVisible || (row.parentThreadId === parent && row.depth >= 1));
  // Enrichment retitles rows while they run, so the render may carry any title the polls saw.
  const widgetShowedIt = kind !== "widget" || (seen.length > 0 && (!target.widgetBin || seen.some((row) => row.topic && (renderedWhileRunning ?? "").includes(row.topic))));
  record("widget", "child-row", label, !finalRow && nestedWhileRunning && widgetShowedIt,
    `${seen.length ? `seen ${seen.length} poll(s) while running as ${JSON.stringify(seen.at(-1))}` : "not observed while running"}; `
    + (kind === "widget" ? `oo-widget --once while running ${renderedWhileRunning === undefined ? "never rendered" : `${widgetShowedIt ? "shows" : "does not show"} its title`} (widget-while-running.txt); ` : "")
    + `after finish ${finalRow ? `still listed as ${finalRow.section}` : "left the widget (projected done)"}; parent=${parent ?? "none"}${parentVisible ? " (visible)" : ""}`);

  if (kind === "plain") {
    const discovery = await waitFor(async () => {
      const result = await oo(["search", "--query", nonce, "--json", "--limit", "20"], { allowFail: true });
      if (result.code !== 0) return undefined;
      const body = JSON.parse(result.stdout);
      return body.matches?.some((match) => match.id === childId && match.match?.role === "assistant") ? body : undefined;
    }, 90_000, 5000);
    const lastTry = discovery ?? JSON.parse((await oo(["search", "--query", nonce, "--json", "--limit", "20"], { allowFail: true })).stdout || "{}");
    record("search", "search", label, Boolean(discovery),
      `oo search --query ${nonce}: backend=${lastTry.backend?.name ?? "?"} matches=${(lastTry.matches ?? []).map((match) => `${match.id}:${match.match?.role}`).join(",") || "none"}`);
    return;
  }

  if (!role) return;
  const roleFile = join(env.OO_HOME ?? join(homedir(), ".owner-operator"), "workspace", ROLES[role].file);
  const instructions = existsSync(roleFile) ? readFileSync(roleFile, "utf8").trim() : "";
  record("roles", "role-file", label, instructions.length > 0, instructions ? `${roleFile}: ${instructions.length} chars` : `${roleFile} is missing or empty`);
  const prompt = await waitFor(async () => {
    const result = await oo(["search", "--session", childId, "--query", nonce, "--role", "user", "--json", "--max-chars", String(Math.max(20_000, instructions.length * 2 + 5_000))], { allowFail: true });
    return result.code === 0 ? JSON.parse(result.stdout).matches?.find((match) => match.match?.role === "user")?.match.text : undefined;
  }, 60_000);
  const boundary = ROLES[role].boundary(childId);
  const collapse = (text) => text.replace(/\s+/g, " ");
  const hasInstructions = Boolean(prompt) && collapse(prompt).includes(collapse(instructions));
  const delivered = Boolean(prompt) && prompt.includes(boundary) && hasInstructions;
  save(`prompt-${label}.txt`, prompt ?? "(no user message found)");
  record("roles", "delivered", label, delivered,
    prompt ? `child's first user message has full instructions=${instructions ? hasInstructions : "n/a"} boundary=${prompt.includes(boundary)} (${JSON.stringify(boundary)})` : "no user message with the nonce in the child transcript");
}

async function verifyWidget() {
  const rows = await ooJson(["session-state", "list"]);
  save("session-state.json", rows);
  const runs = await ooJson(["runs", "list"]);
  const liveParents = new Set(runs.filter((run) => !TERMINAL.has(run.status)).map((run) => run.parentThreadId));
  const stale = rows.filter((row) => row.section === "working" && row.depth === 0 && !liveParents.has(row.id)
    && row.lastMessageAt && Date.now() - Date.parse(row.lastMessageAt) > STALE_WORKING_MS);
  const bySource = Object.groupBy(rows, (row) => row.source);
  for (const [source, sourceRows] of Object.entries(bySource)) {
    const stuck = stale.filter((row) => row.source === source);
    const sections = Object.entries(Object.groupBy(sourceRows, (row) => row.section)).map(([name, list]) => `${name}=${list.length}`).join(" ");
    record("widget", "stale-working", source, stuck.length === 0,
      `${sections}${stuck.length ? `; working with no message for 30+ min: ${stuck.map((row) => `${row.id} "${row.topic}" last ${row.lastMessageAt}`).join("; ")}` : ""}`);
  }
  const rendered = await renderWidget();
  save("widget.txt", rendered.stdout);
  if (rendered.ok === null) return record("widget", "render", null, null, rendered.stdout);
  record("widget", "render", null, rendered.ok && rendered.stdout.includes("Needs you"),
    `${target.widgetBin} --once ${rendered.ok ? "exit 0" : "failed"}; ${rendered.stdout.split("\n").length} lines saved to widget.txt`);
}

async function verifyE2e() {
  const repo = target.repo ?? process.cwd();
  const result = await execFileAsync("npm", ["run", "test:e2e"], { cwd: repo, env: process.env, maxBuffer: 64 << 20, timeout: 1_200_000 })
    .then(({ stdout, stderr }) => ({ ok: true, text: stdout + stderr }), (error) => ({ ok: false, text: `${error.stdout}${error.stderr}` }));
  save("e2e.log", result.text);
  const failed = /✗ (\S+) failed/.exec(result.text)?.[1];
  record("daemon-e2e", "daemon-e2e", null, result.ok,
    result.ok ? "npm run test:e2e passed" : `${failed ?? "a file"} failed (runner stops at the first failure)${/daemon did not become ready/.test(result.text) ? "; output has \"daemon did not become ready\"" : ""}`);
}

function verdict(check) {
  const gap = KNOWN_GAPS.find((known) => known.check === check.check && (!known.harness || check.harness?.startsWith(known.harness))
    && (!known.evidence || known.evidence.test(check.evidence)));
  if (check.ok === null) return { ...check, verdict: "skip" };
  if (check.ok) return { ...check, verdict: "pass", gap: gap?.id };
  return { ...check, verdict: gap ? "known-gap" : "fail", gap: gap?.id };
}

function report(results) {
  const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# Owner Operator live verification`,
    "",
    `- Target: ${opts.target} (${target.description})`,
    `- Started: ${stamp}; evidence: ${out}`,
    `- Result: ${results.filter((r) => r.verdict === "pass").length} pass, ${results.filter((r) => r.verdict === "fail").length} fail, ${results.filter((r) => r.verdict === "known-gap").length} known-gap, ${results.filter((r) => r.verdict === "skip").length} skip`,
    "",
    "| Verdict | Feature | Check | Harness | Evidence |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.verdict}${r.gap ? ` (${r.gap})` : ""} | ${r.feature} | ${r.check} | ${r.harness ?? ""} | ${cell(r.evidence)} |`),
    "",
    "## Known gaps",
    "",
    ...KNOWN_GAPS.map((gap) => {
      const hits = results.filter((r) => r.gap === gap.id);
      const status = gap.unexercised ? `not exercised. ${gap.unexercised}`
        : hits.length === 0 ? "not exercised this run."
        : hits.some((r) => r.verdict === "known-gap") ? `reproduced: ${hits.filter((r) => r.verdict === "known-gap").map((r) => r.harness ?? r.check).join(", ")}.`
        : `not reproduced this run: ${hits.map((r) => r.harness ?? r.check).join(", ")} passed.`;
      return `- **${gap.id}.** ${gap.text} Status: ${status}`;
    }),
  ];
  return lines.join("\n") + "\n";
}

let target;
async function main(checkout) {
  const runtimeRoot = installedRuntimeRoot();
  try {
    if (opts.target === "installed") {
      target = { ooBin: "oo", runtimeRoot, widgetBin: builtWidget(runtimeRoot), description: `global oo -> ${runtimeRoot}` };
    } else {
      const repo = resolve(opts.repo ?? process.cwd());
      target = { ooBin: join(repo, "oo"), repo, runtimeRoot, widgetBin: builtWidget(repo), description: "" };
      log(`starting an isolated daemon from ${repo}`);
      await startCheckoutDaemon(repo, checkout);
      target.description = `${repo} @ ${execFileSyncText("git", ["-C", repo, "rev-parse", "--short", "HEAD"])}, OO_HOME=${checkout.ooHome}, port ${env.OO_PORT}`;
    }
    const doctor = await oo(["doctor"], { allowFail: true });
    const daemonHealth = await health(env.OO_HOME ?? join(homedir(), ".owner-operator"));
    save("doctor.txt", doctor.stdout + doctor.stderr);
    save("health.json", daemonHealth);
    const expectedRoot = target.repo ?? runtimeRoot;
    const doctorOk = /Status: ready/.test(doctor.stdout) && daemonHealth.ok && !daemonHealth.stale && daemonHealth.repoRoot === expectedRoot;
    record("doctor", "doctor", null, doctorOk, `status=${/Status: (.*)/.exec(doctor.stdout)?.[1] ?? "?"} pid=${daemonHealth.pid} repoRoot=${daemonHealth.repoRoot} stale=${daemonHealth.stale}`);
    if (!doctorOk) throw new Error("doctor failed; this instance is not worth driving");

    const wanted = opts.harness ? opts.harness.split(",") : Object.keys(HARNESSES);
    const installed = [];
    for (const harness of wanted) {
      if (!HARNESSES[harness]) throw new Error(`unknown harness ${harness}`);
      const found = await execFileAsync("/usr/bin/which", [HARNESSES[harness].bin]).then(() => true, () => false);
      if (found) installed.push(harness);
      else record("harness-turn", "installed", harness, null, `${HARNESSES[harness].bin} is not on PATH`);
    }
    const roleHarness = opts["role-harness"];
    const roleHarnessReady = installed.includes(roleHarness);
    if (!roleHarnessReady) {
      const why = `role harness ${roleHarness} is ${wanted.includes(roleHarness) ? "not installed" : "outside --harness"}; pass --role-harness`;
      for (const role of Object.keys(ROLES)) record("roles", "delivered", `${roleHarness}+${role}`, null, why);
      record("widget", "child-row", `${roleHarness}+widget`, null, why);
    }
    const turns = [
      ...installed.map((harness) => ({ harness, kind: "plain" })),
      ...(roleHarnessReady ? ["worker", "orchestrator", "widget"].map((kind) => ({ harness: roleHarness, kind })) : []),
    ];
    log(`launching ${turns.length} turns: ${turns.map((t) => (t.kind === "plain" ? t.harness : `${t.harness}+${t.kind}`)).join(", ")}`);
    const launched = launchedTurns;
    for (const turn of turns) {
      const nonce = `OOV_${stamp.slice(0, 19).replace(/-/g, "")}_${turn.harness.replace(/-/g, "")}_${turn.kind}`;
      launched.push({ ...turn, nonce, ...(await launch(turn.harness, TURN_KINDS[turn.kind].task(nonce), TURN_KINDS[turn.kind].role)) });
    }
    const timeline = await followRuns(launched);
    log("runs finished; checking tracking, widget, search, and roles");
    for (const failed of (await Promise.allSettled(launched.map((turn) => verifyTurn(turn, timeline)))).filter((r) => r.status === "rejected")) {
      record("doctor", "completed", null, false, `a check crashed: ${String(failed.reason?.message ?? failed.reason).slice(0, 600)}`);
    }
    await verifyWidget();
    if (opts.e2e) await verifyE2e();
  } catch (error) {
    if (!interrupted) record("doctor", "completed", null, false, `verification aborted: ${error.message.slice(0, 600)}`);
  } finally {
    await finish(checkout);
  }
}

let finishing;
function finish(checkout) {
  finishing ??= (async () => {
    if (interrupted) {
      const live = launchedTurns.filter((turn) => turn.run && !TERMINAL.has(turn.run.status));
      for (const { run } of live) await execFileAsync(target.ooBin, ["runs", "cancel", run.id], { env, timeout: 30_000 }).catch(() => {});
      record("doctor", "completed", null, false, `verification interrupted by ${interrupted}${live.length ? `; cancelled ${live.map(({ run }) => run.id).join(", ")}` : ""}`);
    }
    await stopCheckoutDaemon(checkout);
    const results = checks.map(verdict).sort((a, b) => FEATURES.indexOf(a.feature) - FEATURES.indexOf(b.feature)
      || String(a.harness).localeCompare(String(b.harness)) || a.check.localeCompare(b.check));
    save("report.json", { target: opts.target, description: target?.description, out, results, knownGaps: KNOWN_GAPS });
    save("report.md", report(results));
    process.stdout.write(readFileSync(join(out, "report.md"), "utf8"));
    process.exitCode = results.some((r) => r.verdict === "fail") ? 1 : 0;
  })();
  return finishing;
}

const checkoutState = {};
const launchedTurns = [];
/** An interrupt blocks new `oo` commands, kills the in-flight ones, and cancels this run's turns
 * before cleanup, so nothing restarts a daemon in a home that is about to be deleted. */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, async () => {
    interrupted = signal;
    for (const child of inFlight) child.kill("SIGTERM");
    await finish(checkoutState);
    process.exit(1);
  });
}
await main(checkoutState);

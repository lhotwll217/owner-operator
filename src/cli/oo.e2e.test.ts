// e2e: drive the oo launcher with an isolated Gateway and a loopback model fixture.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";
import { markOnboarded } from "@owner-operator/core";
import { helpTree, rootHelp } from "./help";
import { NOUNS } from "./operations";

const ooBin = join(repoRoot, "oo");
const ooHome = mkdtempSync(join(tmpdir(), "oo-cli-e2e-"));
process.env.OO_HOME = ooHome; // in-process store seam (the --done seed) targets the same hermetic home
delete process.env.OO_AGENT_RUN_LEASE_ID;
const cliEnv = { PATH: process.env.PATH, HOME: ooHome, OO_HOME: ooHome, PI_OFFLINE: "1" };
const opts = { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: cliEnv } as const;
let daemon: Awaited<ReturnType<typeof import("../daemon/runtime")["startDaemon"]>> | null = null;

const runOo = async (
  args: readonly string[],
  { cwd = repoRoot, env = cliEnv }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(ooBin, args, { cwd, env: { ...env, OO_HOME: ooHome } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });

try {
  const help = spawnSync(ooBin, ["--help"], opts);
  assert.equal(help.status, 0, `oo --help exits 0 (got ${help.status}; stderr: ${help.stderr})`);
  assert.match(help.stdout, /oo -p \| --prompt/, "top-level help advertises -p");
  assert.match(help.stdout, /oo --continue/, "top-level help advertises --continue");
  for (const noun of ["session-state", "runs", "schedules", "db", "harness", "search", "skill", "worktrees"]) {
    assert.match(help.stdout, new RegExp(`^  oo ${noun}(\\s|$)`, "m"), `top-level help lists the ${noun} noun`);
  }
  assert.match(help.stdout, /^  oo search .*flags only, no verbs/m, "top-level help says search has flags, not verbs");
  assert.equal(help.stdout, `${rootHelp()}\n`, "`oo --help` prints exactly the text the Operator prompt embeds");
  assert.equal(help.stderr, "", "top-level help is clean: no agent/runtime warnings");

  // The Operator's prompt embeds helpTree(); every page it holds must be what that command prints.
  const pages = [...Object.entries(NOUNS).flatMap(([noun, { verbs }]) => [[noun], ...Object.keys(verbs).map((verb) => [noun, verb])]), ["search"]];
  const printed = await Promise.all(pages.map(async (page) => {
    const result = await runOo([...page, "--help"]);
    assert.equal(result.status, 0, `oo ${page.join(" ")} --help exits 0`);
    return result.stdout.trimEnd();
  }));
  assert.equal(helpTree(), [help.stdout.trimEnd(), ...printed].join("\n\n"),
    "the embedded help tree is exactly `oo --help` then every noun and verb page, in order, as printed");
  assert.equal(existsSync(join(ooHome, "workspace", "AGENTS.md")), true, "every CLI exit seeds the workspace");

  for (const argv of [["daemon", "--help"], ["doctor", "-h"]]) {
    const help = spawnSync(ooBin, argv, opts);
    assert.equal(help.status, 0, `${argv.join(" ")} exits 0`);
    assert.match(help.stdout, /Owner Operator \(oo\)/, `${argv.join(" ")} prints usage`);
  }
  assert.equal(existsSync(join(ooHome, "daemon.json")), false, "`oo daemon --help` starts no daemon");

  // Inside an agent's bash, operations only connect: no daemon is started on the agent's behalf.
  const agentWithoutDaemon = spawnSync(ooBin, ["session-state", "list"], { ...opts, env: { ...opts.env, OO_AGENT: "1" } });
  assert.equal(agentWithoutDaemon.status, 1, `an agent verb without a daemon exits 1 (stderr: ${agentWithoutDaemon.stderr})`);
  assert.match(agentWithoutDaemon.stderr, /daemon is not running; agents do not start it\. Ask the owner to start it \(`oo status`/);
  assert.equal(existsSync(join(ooHome, "daemon.json")), false, "OO_AGENT=1 never spawns a daemon");
  assert.equal(existsSync(join(ooHome, "daemon.log")), false, "OO_AGENT=1 never launches a daemon process");
  const agentRefusal = /^oo: agents reach Owner Operator through `oo <noun> <verb>`/;
  for (const argv of [[], ["daemon"], ["-p", "hi"], ["--continue", "-p", "hi"], ["--session", "x", "-p", "hi"]]) {
    const refused = spawnSync(ooBin, argv, { ...opts, env: { ...opts.env, OO_AGENT: "1" } });
    assert.equal(refused.status, 2, `OO_AGENT=1 refuses \`oo ${argv.join(" ")}\` (stderr: ${refused.stderr})`);
    assert.match(refused.stderr, agentRefusal);
  }
  const leased = spawnSync(ooBin, ["daemon"], { ...opts, env: { ...opts.env, OO_AGENT_RUN_LEASE_ID: "acp-lease" } });
  assert.equal(leased.status, 2, "an ACP child cannot start a replacement daemon");
  assert.match(leased.stderr, agentRefusal);
  assert.equal(existsSync(join(ooHome, "daemon.json")), false, "refused agent forms start no daemon");
  // A discovery file the agent cannot reach names the cause instead of claiming no daemon runs.
  const discovery = (pid: number) => writeFileSync(join(ooHome, "daemon.json"), JSON.stringify({
    port: 9, pid, startedAt: new Date().toISOString(), fingerprint: "e2e", authToken: "e2e-secret-token",
  }));
  discovery(process.pid);
  const unreachable = spawnSync(ooBin, ["session-state", "list"], { ...opts, env: { ...opts.env, OO_AGENT: "1" } });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, new RegExp(`daemon \\(pid ${process.pid}, port 9\\) is running but unreachable from this shell`));
  assert.doesNotMatch(unreachable.stderr, /e2e-secret-token/, "the bearer token never reaches the agent");
  discovery(0x7ffffffe);
  const stale = spawnSync(ooBin, ["session-state", "list"], { ...opts, env: { ...opts.env, OO_AGENT: "1" } });
  assert.match(stale.stderr, /daemon is not running; agents do not start it/, "a dead pid's discovery file means no daemon");
  rmSync(join(ooHome, "daemon.json"));

  // Bare `oo` without a terminal points at the current headless spelling.
  const notTty = spawnSync(ooBin, [], { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(notTty.status, 1);
  assert.match(notTty.stderr, /`oo -p "question"`/, "the non-TTY hint names -p");
  assert.doesNotMatch(notTty.stderr, /oo "question"/, "the removed bare-prompt spelling is gone");

  const nounHelp = spawnSync(ooBin, ["session-state", "--help"], opts);
  assert.equal(nounHelp.status, 0, `noun help exits 0 (stderr: ${nounHelp.stderr})`);
  assert.match(nounHelp.stdout, /^\s+list\s/m, "noun help lists list");
  assert.match(nounHelp.stdout, /^\s+done <id\.\.\.>\s/m, "noun help lists done");
  const unknownVerb = spawnSync(ooBin, ["session-state", "nope"], opts);
  assert.equal(unknownVerb.status, 2, "unknown verb exits 2");
  assert.match(unknownVerb.stderr, /unknown verb "nope"/);

  const setupRequired = spawnSync(ooBin, ["-p", "what is happening?"], opts);
  assert.equal(setupRequired.status, 2, "fresh headless runs fail closed before model or daemon work");
  assert.match(setupRequired.stderr, /setup required.*run `oo`/is);
  assert.equal(setupRequired.stdout, "");
  markOnboarded(ooHome, { via: "e2e" });

  const operatorParent = {
    ...opts.env, OO_AGENT: "1", OO_CAN_PROMPT: "1", OO_CURRENT_SESSION_ID: "operator-parent",
  };
  const offlinePrompt = spawnSync(ooBin, ["-p", "hi"], { ...opts, env: operatorParent });
  assert.equal(offlinePrompt.status, 1, `a nested prompt reports a connection failure (stderr: ${offlinePrompt.stderr})`);
  assert.match(offlinePrompt.stderr, /daemon is not running; agents do not start it/);
  assert.equal(existsSync(join(ooHome, "daemon.log")), false, "a nested prompt cannot spawn the daemon");
  const mixedPrompt = spawnSync(ooBin, ["-i", "-p", "hi"], { ...opts, env: operatorParent });
  assert.equal(mixedPrompt.status, 2, mixedPrompt.stderr);
  assert.match(mixedPrompt.stderr, /^oo: -i\/--interactive is only valid by itself/);
  for (const argv of [[], ["daemon"], ["--continue", "-p", "hi"], ["--session", "x", "-p", "hi"]]) {
    const refused = spawnSync(ooBin, argv, { ...opts, env: operatorParent });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, agentRefusal);
  }
  for (const env of [
    { ...operatorParent, OO_CAN_PROMPT: "0" },
    { ...operatorParent, OO_CURRENT_SESSION_ID: "" },
    { ...operatorParent, OO_AGENT_RUN_LEASE_ID: "acp-lease" },
  ]) {
    const refused = spawnSync(ooBin, ["-p", "hi"], { ...opts, env });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, agentRefusal);
  }

  const barePrompt = spawnSync(ooBin, ["what", "changed"], opts);
  assert.equal(barePrompt.status, 2, `bare prompt exits 2 (got ${barePrompt.status}; stderr: ${barePrompt.stderr})`);
  assert.match(barePrompt.stderr, /unknown command "what".*oo -p "what changed"/, "bare prompt names -p");
  assert.equal(barePrompt.stdout, "", "bare prompt does not build a model session");

  for (const [argv, replacement] of [
    [["--json"], /oo session-state list --json/],
    [["--session-state"], /oo session-state list/],
    [["--done", "x"], /oo session-state done <id\.\.\.>/],
    [[["one", "shot"].join("-"), "what changed?"], /oo -p/],
    [[["one", "shot"].join(""), "what changed?"], /oo -p/],
  ] as const) {
    const removed = spawnSync(ooBin, [...argv], opts);
    assert.equal(removed.status, 2, `${argv.join(" ")} exits 2 (got ${removed.status}; stderr: ${removed.stderr})`);
    assert.match(removed.stderr, replacement, `${argv.join(" ")} names its replacement`);
    assert.equal(removed.stdout, "", `${argv.join(" ")} does not build a model session`);
  }

  const trailingSession = spawnSync(ooBin, ["-p", "hi", "--session"], opts);
  assert.equal(trailingSession.status, 2, `trailing --session exits 2 (got ${trailingSession.status}; stderr: ${trailingSession.stderr})`);
  assert.match(trailingSession.stderr, /--session needs an id or path/, "trailing --session names the missing value");
  assert.equal(trailingSession.stdout, "", "trailing --session exits before stdout/model work");

  const mixedInteractive = spawnSync(ooBin, ["--continue", "-i"], opts);
  assert.equal(mixedInteractive.status, 2, `mixed -i exits 2 (got ${mixedInteractive.status}; stderr: ${mixedInteractive.stderr})`);
  assert.match(mixedInteractive.stderr, /only valid by itself/, "-i with resume is rejected before agent setup");
  assert.equal(mixedInteractive.stdout, "", "mixed -i exits before stdout/model work");

  const missingSession = spawnSync(ooBin, ["--session", "nope123", "-p", "hi"], opts);
  assert.equal(missingSession.status, 2, `unknown --session exits 2 (got ${missingSession.status}; stderr: ${missingSession.stderr})`);
  assert.match(missingSession.stderr, /no oo session matching "nope123"/, "names the unmatched session ref");
  assert.equal(missingSession.stdout, "", "nothing on stdout for a bad session ref");

  // --done crosses the real client → gateway → state seam; no embedded state fallback.
  const { startDaemon } = await import("../daemon/runtime");
  daemon = await startDaemon({
    port: 0,
    dbPath: join(ooHome, "state.db"),
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
  });
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { role, content } = JSON.parse(body).messages.at(-1);
    const message = JSON.stringify(content);
    let delta;
    if (role === "user" && (message.includes("start-fixture") || message.includes("second-fixture"))) {
      const command = message.includes("start-fixture") ? "oo --prompt second-fixture" : "oo -p third-fixture";
      delta = { role: "assistant", tool_calls: [{
        index: 0, id: "ask_oo", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) },
      }] };
    } else {
      const text = message.includes("agents reach Owner Operator") ? "nested prompt refused"
        : message.includes("nested prompt refused") ? "parent received child reply" : "unexpected turn";
      delta = { role: "assistant", content: text };
    }
    const choice = { index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  try {
    const address = provider.address();
    assert.ok(address && typeof address === "object");
    const piDir = join(ooHome, "pi");
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture",
      models: [{ id: "local" }],
    } } }));
    writeFileSync(join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "local" }));
    const reply = await runOo(["-p", "start-fixture"]);
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(reply.stdout.trim(), "parent received child reply");
    const parentId = /\[oo\] session (\S+)/.exec(reply.stderr)?.[1];
    assert.ok(parentId, reply.stderr);
    const sessions = await (await import("../agent/agent")).listOoSessions();
    assert.equal(sessions.length, 2, "only the root and its fresh child run");
    assert.match(sessions.find((session) => session.id !== parentId)?.name ?? "", new RegExp(`chat ← ${parentId} @`));
    for (const env of [
      { ...cliEnv, OO_EVAL_READ_ONLY: "1" },
      { ...cliEnv, OO_EVAL_BASELINE_PROMPT: join(repoRoot, "src", "prompts", "owner-operator.md") },
    ]) {
      const restricted = await runOo(["-p", "second-fixture"], { env });
      assert.equal(restricted.status, 0, restricted.stderr);
      assert.equal(restricted.stdout.trim(), "nested prompt refused", "a restricted eval cannot open another Operator");
    }
  } finally {
    provider.close();
  }

  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  daemon.state.recordObservation({
    id: "e2e-done-1", source: "claude", repo: "demo", app: "Claude CLI", topic: "ship it",
    lastRole: "user", working: false, secondsSinceLastMessage: 30, secondsSinceActivity: 30,
    createdAt: recent, lastMessageAt: recent,
  });
  const noIds = spawnSync(ooBin, ["session-state", "done"], opts);
  assert.equal(noIds.status, 2, `bare done exits 2 (got ${noIds.status}; stderr: ${noIds.stderr})`);
  assert.match(noIds.stderr, /expected <id\.\.\.>/, "bare done names the missing ids");

  const list = await runOo(["session-state", "list", "--json"]);
  assert.equal(list.status, 0, `session-state list exits 0 (stderr: ${list.stderr})`);
  const listed = JSON.parse(list.stdout) as Array<{ id: string; state: string }>;
  assert.deepEqual(listed.map((row) => row.id), ["e2e-done-1"], "the seeded row is current");
  assert.deepEqual(listed, daemon.state.listCurrentSessionState(), "list --json returns the GET /session-state rows");
  const listText = await runOo(["session-state", "list"]);
  assert.match(listText.stdout, /1\. .*e2e-done-1/, "text list shows a numbered row with its id");
  const seededState = listed[0]!.state;
  const otherState = seededState === "idle" ? "working" : "idle";
  assert.deepEqual(JSON.parse((await runOo(["session-state", "list", "--state", seededState, "--json"])).stdout),
    listed, "--state keeps rows in that exact state");
  const filteredOut = await runOo(["session-state", "list", "--state", otherState]);
  assert.equal(filteredOut.status, 0, `an empty filter is an answer, not a failure (stderr: ${filteredOut.stderr})`);
  assert.equal(filteredOut.stdout, `no sessions in state ${otherState}\n`);
  assert.equal(daemon.state.snoozeThread("e2e-done-1", { kind: "next-message" }), "applied");
  assert.equal((await runOo(["session-state", "list", "--state", seededState])).stdout, `no sessions in state ${seededState}\n`,
    "--state filters on the widget section, so a snoozed row never reports in its state");
  assert.match((await runOo(["session-state", "list"])).stdout, /1\. snoozed .*e2e-done-1/, "text list prints the section");
  assert.deepEqual(JSON.parse((await runOo(["session-state", "list", "--state", "snoozed", "--json"])).stdout).map((r: { id: string }) => r.id),
    ["e2e-done-1"], "--state snoozed lists the snoozed row");
  daemon.state.snoozeThread("e2e-done-1", null);
  const badState = await runOo(["session-state", "list", "--state", "blocked"]);
  assert.equal(badState.status, 2, `unknown --state exits 2 (got ${badState.status})`);
  assert.match(badState.stderr, /needs-you, working, idle, snoozed/, "names the valid sections");
  assert.equal((await runOo(["session-state", "list", "--state", "done"])).status, 2, "done is not a section, so --state done exits 2");

  const done = await runOo(["session-state", "done", "e2e-done-1", "ghost-id"]);
  assert.equal(done.status, 1, `done with a ghost id exits 1 (got ${done.status}; stderr: ${done.stderr})`);
  const doneOut = JSON.parse((await runOo(["session-state", "done", "e2e-done-1", "--json"])).stdout) as { alreadyDoneIds: string[] };
  assert.deepEqual(doneOut.alreadyDoneIds, ["e2e-done-1"], "done --json returns the POST /done result");
  assert.match(done.stdout, /done\s+e2e-done-1/, "seeded thread marked done");
  assert.match(done.stdout, /missing\s+ghost-id/, "unknown id reported, not silently dropped");

  // Worktree verbs act for a session: the Operator's own bash, then --from-session, else a usage error.
  const repository = join(ooHome, "repo");
  mkdirSync(repository);
  for (const argv of [["init", "-q"], ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    assert.equal(spawnSync("git", argv, { cwd: repository }).status, 0, `git ${argv.at(-1)}`);
  }
  const noSession = await runOo(["worktrees", "list"]);
  assert.equal(noSession.status, 2, `a worktree verb with no session exits 2 (stderr: ${noSession.stderr})`);
  assert.match(noSession.stderr, /no session to act for: pass --from-session/);
  const operatorBash = { ...cliEnv, OO_CURRENT_SESSION_ID: "e2e-root" };
  const created = await runOo(["worktrees", "create", "--repository", ".", "--name", "e2e-wt", "--json"], { cwd: repository, env: operatorBash });
  assert.equal(created.status, 0, `worktrees create exits 0 (stderr: ${created.stderr})`);
  const createdOut = JSON.parse(created.stdout) as { action: string; created: boolean; worktree: { id: string; path: string; selected: boolean } };
  assert.equal(createdOut.action, "create", "create --json returns the POST /worktrees/use payload");
  assert.equal(createdOut.worktree.selected, true, "create selects the worktree for the Operator session running the bash");
  assert.equal(daemon.state.selectedWorktree("e2e-root")?.id, createdOut.worktree.id, "selection is durable under the session id");
  const listedWorktrees = await runOo(["worktrees", "list", "--from-session", "e2e-other"]);
  assert.match(listedWorktrees.stdout, new RegExp(`^${createdOut.worktree.id}\\s+available\\s+repo\\s+${createdOut.worktree.path}$`, "m"),
    "text list shows one line per worktree, unselected for another session");
  const selected = await runOo(["worktrees", "select", createdOut.worktree.id, "--from-session", "e2e-other"], { env: operatorBash });
  assert.equal(selected.status, 0, `worktrees select exits 0 (stderr: ${selected.stderr})`);
  assert.match(selected.stdout, /\sselected\s/, "select reports the selected worktree");
  assert.equal(daemon.state.selectedWorktree("e2e-other")?.id, createdOut.worktree.id, "--from-session wins over OO_CURRENT_SESSION_ID");
} finally {
  await daemon?.close();
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — oo grammar: help, nouns, -p, session-state list/done and worktrees create/list/select over the Gateway; removed spellings and bad resume args exit 2\n");

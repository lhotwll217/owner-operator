// Runs the installed script the way Claude Code runs a "type": "command" hook: bare /bin/sh,
// no login shell, and a PATH that cannot find node.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { MANAGED_HOOK_MARKER } from "./claude-settings";
import { hookScriptPath, hookSpoolDir, installClaudeHooks, publishHookEndpoint } from "./install";

interface HookPost {
  body: string;
  authorization: string | undefined;
  contentType: string | undefined;
}

interface HookListener {
  port: number;
  posts: HookPost[];
  close: () => Promise<void>;
}

async function hookListener(reply: number): Promise<HookListener> {
  const posts: HookPost[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      posts.push({
        body,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
      });
      response.writeHead(reply);
      response.end(reply === 204 ? undefined : JSON.stringify({ reply }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "the listener must report a numeric port");
  return {
    port: address.port,
    posts,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function managedCommand(settingsPath: string): string {
  const parsed = parse(readFileSync(settingsPath, "utf8")) as
    { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
  const commands = Object.values(parsed.hooks ?? {})
    .flatMap((definitions) => definitions.flatMap((definition) => definition.hooks ?? []))
    .map((hook) => hook.command)
    .filter((command): command is string => typeof command === "string" && command.includes(MANAGED_HOOK_MARKER));
  assert.ok(commands.length > 0, "install must leave a managed command in the settings file");
  return commands[0] as string;
}

const root = mkdtempSync(join(tmpdir(), "oo-hook-script-"));
const ooHome = join(root, "oo");
const claudeDir = join(root, "claude");

// Only the utilities the script needs, so a node found elsewhere on PATH cannot mask a missing one.
const strippedBin = join(root, "stripped-bin");
mkdirSync(strippedBin, { recursive: true });
for (const tool of ["cat", "date", "mkdir"]) {
  const resolved = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  assert.ok(resolved, `${tool} must be on PATH to run the hook script at all`);
  symlinkSync(resolved, join(strippedBin, tool));
}
const strippedEnv = { PATH: strippedBin, HOME: root };

const payload = (sessionId: string): string => JSON.stringify({
  session_id: sessionId,
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf build" },
  cwd: "/work/owner-operator",
});

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The listener runs in this process, so the hook has to run asynchronously or it would block the
// event loop and every post would time out.
function runShell(args: string[], sessionId: string): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", args, { env: strippedEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(payload(sessionId));
  });
}

const runHook = (script: string, sessionId: string): Promise<HookRun> => runShell([script], sessionId);

const spooled = (home = ooHome): string[] =>
  existsSync(hookSpoolDir(home)) ? readdirSync(hookSpoolDir(home)) : [];

try {
  assert.notEqual(
    spawnSync("/bin/sh", ["-c", "command -v node"], { env: strippedEnv }).status,
    0,
    "the stripped PATH must not find node, or this test cannot prove the hook stopped needing it",
  );
  assert.ok(existsSync("/usr/bin/curl"), "the hook posts through /usr/bin/curl, which must exist here");

  mkdirSync(claudeDir, { recursive: true });
  installClaudeHooks(ooHome, claudeDir);
  const script = hookScriptPath(ooHome);

  const accepted = await hookListener(200);
  try {
    publishHookEndpoint(accepted.port, "hook-token", ooHome);
    const live = await runHook(script, "curl-session");
    assert.equal(live.status, 0, `the hook must exit 0; stderr: ${live.stderr}`);
    assert.equal(live.stdout, "{}\n", "Claude reads stdout first, so the hook answers before any work");
    assert.equal(accepted.posts.length, 1, `the daemon must receive the event; stderr: ${live.stderr}`);
    assert.deepEqual(JSON.parse(accepted.posts[0]?.body ?? "null"), JSON.parse(payload("curl-session")));
    assert.equal(accepted.posts[0]?.authorization, "Bearer hook-token");
    assert.equal(accepted.posts[0]?.contentType, "application/json");
    assert.deepEqual(spooled(), [], "a delivered event is never spooled");
  } finally {
    await accepted.close();
  }

  const ignored = await hookListener(204);
  try {
    publishHookEndpoint(ignored.port, "hook-token", ooHome);
    const live = await runHook(script, "ignored-session");
    assert.equal(live.status, 0, `a 204 must still exit 0; stderr: ${live.stderr}`);
    assert.equal(ignored.posts.length, 1);
    assert.deepEqual(spooled(), [], "the daemon ignoring an event is delivery, not failure");
  } finally {
    await ignored.close();
  }

  const refused = await hookListener(500);
  try {
    publishHookEndpoint(refused.port, "hook-token", ooHome);
    const live = await runHook(script, "rejected-session");
    assert.equal(live.status, 0, `a 500 must still exit 0; stderr: ${live.stderr}`);
    assert.equal(live.stdout, "{}\n");
    assert.equal(refused.posts.length, 1);
    assert.equal(spooled().length, 1, "a rejected post falls back to the spool");
    for (const name of spooled()) rmSync(join(hookSpoolDir(ooHome), name));
  } finally {
    await refused.close();
  }

  const closed = await hookListener(200);
  const closedPort = closed.port;
  await closed.close();
  publishHookEndpoint(closedPort, "hook-token", ooHome);
  const offline = await runHook(script, "offline-session");
  assert.equal(offline.status, 0, `a refused connection must still exit 0; stderr: ${offline.stderr}`);
  assert.equal(offline.stdout, "{}\n");
  assert.equal(spooled().length, 1, "no daemon listening falls back to the spool");

  const awkwardHome = join(root, "My OO Home's dir");
  const awkwardClaudeDir = join(root, "claude-awkward");
  mkdirSync(awkwardClaudeDir, { recursive: true });
  installClaudeHooks(awkwardHome, awkwardClaudeDir);
  const quoted = await hookListener(200);
  try {
    publishHookEndpoint(quoted.port, "awkward-token", awkwardHome);
    const command = managedCommand(join(awkwardClaudeDir, "settings.json"));
    const shell = await runShell(["-c", command], "awkward-session");
    assert.equal(shell.status, 0, `a space in OO_HOME must not break the hook; stderr: ${shell.stderr}`);
    assert.equal(shell.stdout, "{}\n");
    assert.equal(quoted.posts.length, 1, `the command string Claude runs must reach the daemon; stderr: ${shell.stderr}`);
    assert.equal(JSON.parse(quoted.posts[0]?.body ?? "null").session_id, "awkward-session");
  } finally {
    await quoted.close();
  }
  // The spool writes through a temporary name and renames it in, so its own quoting has to survive
  // the same home, and the rename has to find `mv` on a PATH that does not carry one.
  const awkwardSpool = await runHook(hookScriptPath(awkwardHome), "awkward-spool");
  assert.equal(awkwardSpool.status, 0, `spooling must survive a space in OO_HOME; stderr: ${awkwardSpool.stderr}`);
  assert.deepEqual(spooled(awkwardHome).map((name) => /^\d+-\d+-\d*\.json$/.test(name)), [true],
    "one complete event lands, with no temporary file left beside it");

  console.log("ok - the hook script posts over curl without node and survives a spaced OO_HOME");
} finally {
  rmSync(root, { recursive: true, force: true });
}

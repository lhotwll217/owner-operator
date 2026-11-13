// The installed script re-reads endpoint.env on every event and spools when the daemon is down.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../state/state";
import { startGateway } from "../gateway/server";
import { drainHookSpool, hookScriptPath, installClaudeHooks, publishHookEndpoint } from "./install";

const root = mkdtempSync(join(tmpdir(), "oo-hook-install-"));
const ooHome = join(root, "oo");
const claudeDir = join(root, "claude");
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(claudeDir, "settings.json"), `{
  // owner comment
  "theme": "dark",
  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo keep-me" }] }] }
}
`);

const previousHome = process.env.OO_HOME;
process.env.OO_HOME = ooHome;

try {
  const status = installClaudeHooks(ooHome, claudeDir);
  assert.equal(status.script, "installed");
  assert.equal(status.settings, "installed");
  const settings = readFileSync(join(claudeDir, "settings.json"), "utf8");
  assert.match(settings, /owner comment/);
  assert.match(settings, /echo keep-me/);
  assert.match(settings, /claude-hook\.sh/);

  const script = hookScriptPath(ooHome);
  const payload = JSON.stringify({
    session_id: "spool-session",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    cwd: "/work/owner-operator",
  });
  const offline = spawnSync("sh", [script], { input: payload, encoding: "utf8" });
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /\{\}/);
  const spooled = readdirSync(join(ooHome, "hooks", "spool"));
  assert.equal(spooled.length, 1);

  const state = new State(join(ooHome, "state.db"));
  const gateway = await startGateway({
    authToken: "hook-token", state, port: 0,
    monitor: { poll: async () => [] },
    health: () => ({ ok: true, port: gateway.port, pid: process.pid, startedAt: "now", fingerprint: "test", stale: false, repoRoot: "/test" }),
    ready: () => ({ ready: true, setupRequired: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }),
    scheduler: {} as never, agentRuns: {} as never, worktrees: {} as never, query: {} as never, harness: {} as never, search: {} as never,
  });
  try {
    publishHookEndpoint(gateway.port, "hook-token", ooHome);
    assert.equal(drainHookSpool((hook) => state.recordHook({
      harness: "claude", source: "claude", app: "Claude CLI", ...hook,
    }), ooHome), 1);
    assert.equal(state.listCurrentSessionState().find((row) => row.id === "spool-session")?.state, "needs-you");

    const live = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn("sh", [script], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
      child.stdin.end(JSON.stringify({
        session_id: "live-session",
        hook_event_name: "UserPromptSubmit",
        prompt: "rename the export",
        cwd: "/work/owner-operator",
      }));
    });
    assert.equal(live.status, 0, live.stderr);
    assert.equal(state.listCurrentSessionState().find((row) => row.id === "live-session")?.state, "working");
    assert.equal(readdirSync(join(ooHome, "hooks", "spool")).length, 0);
  } finally {
    await gateway.close();
    state.close();
  }
  console.log("ok - hook script re-sources the endpoint and spools when it is down");
} finally {
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}

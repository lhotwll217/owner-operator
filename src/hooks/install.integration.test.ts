// The installed script re-reads endpoint.env on every event and spools when the daemon is down.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { State } from "../state/state";
import { startGateway } from "../gateway/server";
import { CLAUDE_HOOK_EVENTS, claudeHookEventsFor } from "./claude-settings";
import {
  drainHookSpool,
  hookScriptPath,
  hookStatus,
  installClaudeHooks,
  probeClaudeVersion,
  publishHookEndpoint,
  uninstallClaudeHooks,
} from "./install";

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
  const probed = probeClaudeVersion();
  assert.ok(probed === null || /^\d+\.\d+\.\d+$/.test(probed), `the probe returns a version or nothing, got ${probed}`);

  // A settings file Claude Code would reject is left exactly as the owner left it: splicing a
  // hooks block into broken JSON leaves the whole file rejected, so the owner's rules stop applying.
  const malformed = {
    truncated: `{\n  "permissions": { "allow": ["Bash(ls:*)"] },\n`,
    trailingComma: `{\n  "permissions": { "allow": ["Bash(ls:*)"] },\n}\n`,
    mergeConflict: `<<<<<<< HEAD\n{ "theme": "dark" }\n=======\n{ "theme": "light" }\n>>>>>>> other\n`,
    garbage: "this is not json at all\n",
    yaml: "theme: dark\npermissions:\n  allow:\n    - Bash\n",
    stringRoot: `"{\\"theme\\":\\"dark\\"}"\n`,
    arrayRoot: "[1, 2, 3]\n",
  };
  for (const [shape, text] of Object.entries(malformed)) {
    const brokenDir = join(root, `claude-${shape}`);
    const brokenHome = join(root, `oo-${shape}`);
    const brokenPath = join(brokenDir, "settings.json");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(brokenPath, text, { mode: 0o640 });

    const refused = installClaudeHooks(brokenHome, brokenDir, "2.1.280");
    assert.equal(refused.settings, "unparsable", `${shape} must report the refusal`);
    assert.equal(refused.script, "installed", `${shape} still gets our own managed script`);
    assert.equal(readFileSync(brokenPath, "utf8"), text, `${shape} is left byte for byte unchanged`);
    assert.equal(hookStatus(brokenHome, brokenDir, "2.1.280").settings, "unparsable",
      `${shape} keeps reporting the refusal, so oo hooks status tells the truth`);
    assert.equal(uninstallClaudeHooks(brokenHome, brokenDir).settings, "unparsable",
      `${shape} must not be rewritten on uninstall either`);
    assert.equal(readFileSync(brokenPath, "utf8"), text, `${shape} survives an uninstall unchanged`);
    assert.deepEqual(readdirSync(brokenDir), ["settings.json"], `${shape} leaves no temp file behind`);
  }

  const validDir = join(root, "claude-valid");
  const validHome = join(root, "oo-valid");
  const validPath = join(validDir, "settings.json");
  mkdirSync(validDir, { recursive: true });
  writeFileSync(validPath, `{
  // owner comment
  "permissions": { "allow": ["Bash(ls:*)"], "deny": ["Read(./.env)"] },
  "theme": "dark",
  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo keep-me" }] }] }
}
`, { mode: 0o640 });
  const installed = installClaudeHooks(validHome, validDir, "2.1.280");
  assert.equal(installed.settings, "installed");
  assert.equal(installed.claudeVersion, "2.1.280");
  const validText = readFileSync(validPath, "utf8");
  const validParsed = parse(validText) as {
    permissions?: unknown; theme?: unknown; hooks?: Record<string, unknown>;
  };
  assert.deepEqual(validParsed.permissions, { allow: ["Bash(ls:*)"], deny: ["Read(./.env)"] },
    "the permission rules the owner cares about survive the merge");
  assert.equal(validParsed.theme, "dark");
  assert.match(validText, /owner comment/);
  assert.match(validText, /echo keep-me/);
  assert.deepEqual(Object.keys(validParsed.hooks ?? {}).sort(), [...CLAUDE_HOOK_EVENTS].sort());
  assert.deepEqual(readdirSync(validDir), ["settings.json"], "the temp file is renamed, never left behind");
  assert.equal(statSync(validPath).mode & 0o777, 0o640, "the owner's file mode survives the rewrite");

  const gatedDir = join(root, "claude-gated");
  const gatedHome = join(root, "oo-gated");
  mkdirSync(gatedDir, { recursive: true });
  const gated = installClaudeHooks(gatedHome, gatedDir, null);
  assert.equal(gated.settings, "installed");
  assert.equal(gated.claudeVersion, null);
  const gatedHooks = (parse(readFileSync(join(gatedDir, "settings.json"), "utf8")) as
    { hooks?: Record<string, unknown> }).hooks ?? {};
  assert.deepEqual(Object.keys(gatedHooks).sort(), [...claudeHookEventsFor(null)].sort(),
    "an unreadable Claude version installs the core lifecycle instead of events it cannot verify");

  console.log("ok - hook script re-sources the endpoint and spools when it is down");
} finally {
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}

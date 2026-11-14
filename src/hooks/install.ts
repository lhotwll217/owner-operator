import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeHookFact } from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import {
  claudeHookEventsFor,
  isParsableClaudeSettings,
  MANAGED_HOOK_MARKER,
  mergeClaudeHookSettings,
  removeClaudeHookSettings,
} from "./claude-settings";

export const hookDir = (ooHome = ownerOperatorHome()): string => join(ooHome, "hooks");
export const hookScriptPath = (ooHome = ownerOperatorHome()): string => join(hookDir(ooHome), "claude-hook.sh");
export const hookEndpointPath = (ooHome = ownerOperatorHome()): string => join(hookDir(ooHome), "endpoint.env");
export const hookSpoolDir = (ooHome = ownerOperatorHome()): string => join(hookDir(ooHome), "spool");

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read endpoint.env on every event. Print `{}` before any work so a permission hook cannot fail
 * closed. Post through curl at an absolute path, because Claude Code runs a `"type": "command"`
 * hook as a bare exec whose PATH usually cannot find a version-managed `node`. The flags follow
 * Orca's, which drives the same hook on the same loopback port:
 * https://github.com/stablyai/orca/blob/dcd69a06f323ea73d788acc395ac4e9b0dbf9ecb/src/main/agent-hooks/installation/scripts/hook-post-command.ts#L67-L80
 * `-f` is ours, because a non-2xx reply has to reach `spool_payload`, and plain curl exits 0 on one.
 * `command -p curl` covers a host with no `/usr/bin/curl`, such as NixOS.
 */
export function claudeHookScript(endpointFile: string, spoolDir: string): string {
  const endpoint = shellQuote(endpointFile);
  const spool = shellQuote(spoolDir);
  return `#!/bin/sh
printf '{}\\n'
payload=$(cat)
if [ -r ${endpoint} ]; then
  set -a
  . ${endpoint}
  set +a
fi
spool_payload() {
  mkdir -p ${spool}
  printf '%s' "$payload" > ${spool}/$(date +%s)-$$-$RANDOM.json
}
if [ -z "$OO_HOOK_PORT" ] || [ -z "$OO_HOOK_TOKEN" ]; then
  spool_payload
  exit 0
fi
post_payload() {
  printf '%s' "$payload" | "$@" -s -f --noproxy 127.0.0.1 --max-time 2 \\
    -X POST "http://127.0.0.1:$OO_HOOK_PORT/hooks/claude" \\
    -H "authorization: Bearer $OO_HOOK_TOKEN" \\
    -H 'content-type: application/json' \\
    --data-binary @- >/dev/null 2>&1
}
if [ -x /usr/bin/curl ]; then
  post_payload /usr/bin/curl || spool_payload
else
  post_payload command -p curl || spool_payload
fi
exit 0
`;
}

export interface HookInstallStatus {
  script: "installed" | "missing";
  scriptPath: string;
  /** `unparsable` means the file is there, Claude Code would reject it, and we left it alone. */
  settings: "installed" | "missing" | "absent" | "unparsable";
  settingsPath: string;
  endpoint: "published" | "missing";
  /** Null when `claude --version` could not be read, which narrows the installed event set. */
  claudeVersion: string | null;
}

function settingsPath(claudeDir: string): string {
  return join(claudeDir, "settings.json");
}

/**
 * The running Claude Code's version, or null. A launcher such as `npx claude` answers `--version`
 * with its own version, so only Claude's own `x.y.z (Claude Code)` line counts.
 */
export function probeClaudeVersion(): string | null {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (probe.status !== 0) return null;
  return /(\d+\.\d+\.\d+)\s+\(Claude Code\)/i.exec(`${probe.stdout}${probe.stderr}`)?.[1] ?? null;
}

function writeScript(ooHome: string): string {
  const path = hookScriptPath(ooHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, claudeHookScript(hookEndpointPath(ooHome), hookSpoolDir(ooHome)), { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** Rename over the original, in its directory, so no crash can leave a half-written settings file. */
function replaceFile(path: string, text: string): void {
  const temp = `${path}.oo-${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode: existsSync(path) ? statSync(path).mode & 0o777 : undefined });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function installClaudeHooks(
  ooHome = ownerOperatorHome(),
  claudeDir = claudeConfigDir(),
  claudeVersion = probeClaudeVersion(),
): HookInstallStatus {
  const command = shellQuote(writeScript(ooHome));
  const path = settingsPath(claudeDir);
  mkdirSync(claudeDir, { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  const merged = mergeClaudeHookSettings(current, command, claudeHookEventsFor(claudeVersion));
  if (merged !== null) replaceFile(path, merged);
  return hookStatus(ooHome, claudeDir, claudeVersion);
}

export function uninstallClaudeHooks(
  ooHome = ownerOperatorHome(),
  claudeDir = claudeConfigDir(),
  claudeVersion = probeClaudeVersion(),
): HookInstallStatus {
  const path = settingsPath(claudeDir);
  if (existsSync(path)) {
    const removed = removeClaudeHookSettings(readFileSync(path, "utf8"));
    if (removed !== null) replaceFile(path, removed);
  }
  rmSync(hookScriptPath(ooHome), { force: true });
  return hookStatus(ooHome, claudeDir, claudeVersion);
}

export function hookStatus(
  ooHome = ownerOperatorHome(),
  claudeDir = claudeConfigDir(),
  claudeVersion = probeClaudeVersion(),
): HookInstallStatus {
  const path = settingsPath(claudeDir);
  const settingsText = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    script: existsSync(hookScriptPath(ooHome)) ? "installed" : "missing",
    scriptPath: hookScriptPath(ooHome),
    settings: !existsSync(path)
      ? "absent"
      : !isParsableClaudeSettings(settingsText)
        ? "unparsable"
        : settingsText.includes(MANAGED_HOOK_MARKER) ? "installed" : "missing",
    settingsPath: path,
    endpoint: existsSync(hookEndpointPath(ooHome)) ? "published" : "missing",
    claudeVersion,
  };
}

/** The daemon rewrites this on every bind. The hook script sources it on every event. */
export function publishHookEndpoint(port: number, token: string, ooHome = ownerOperatorHome()): void {
  const path = hookEndpointPath(ooHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `OO_HOOK_PORT=${port}\nOO_HOOK_TOKEN=${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface SpooledClaudeHook {
  sessionId: string;
  fact: NonNullable<ReturnType<typeof claudeHookFact>>;
  cwd?: string;
  prompt?: string;
}

/** Parse one spooled body. Null when it cannot be applied. */
export function readSpooledHook(raw: string): SpooledClaudeHook | null {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const payload = body as Record<string, unknown>;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const fact = claudeHookFact(payload);
  if (!sessionId || !fact) return null;
  return {
    sessionId,
    fact,
    ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
    ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
  };
}

/** Apply spooled events in name order and delete each file that applied. */
export function drainHookSpool(
  apply: (hook: SpooledClaudeHook) => void,
  ooHome = ownerOperatorHome(),
): number {
  const dir = hookSpoolDir(ooHome);
  if (!existsSync(dir)) return 0;
  let applied = 0;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const hook = readSpooledHook(readFileSync(path, "utf8"));
    if (!hook) continue;
    apply(hook);
    rmSync(path, { force: true });
    applied += 1;
  }
  return applied;
}

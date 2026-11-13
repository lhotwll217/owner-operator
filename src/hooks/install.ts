import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeHookFact } from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import { MANAGED_HOOK_MARKER, mergeClaudeHookSettings, removeClaudeHookSettings } from "./claude-settings";

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

/** Read endpoint.env on every event. Print `{}` before any work so a permission hook cannot fail closed. */
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
printf '%s' "$payload" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  fetch("http://127.0.0.1:" + process.env.OO_HOOK_PORT + "/hooks/claude", {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.OO_HOOK_TOKEN,
      "content-type": "application/json",
    },
    body: raw,
    signal: AbortSignal.timeout(2000),
  }).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));
});
' || spool_payload
exit 0
`;
}

export interface HookInstallStatus {
  script: "installed" | "missing";
  scriptPath: string;
  settings: "installed" | "missing" | "absent";
  settingsPath: string;
  endpoint: "published" | "missing";
}

function settingsPath(claudeDir: string): string {
  return join(claudeDir, "settings.json");
}

function writeScript(ooHome: string): string {
  const path = hookScriptPath(ooHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, claudeHookScript(hookEndpointPath(ooHome), hookSpoolDir(ooHome)), { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function installClaudeHooks(ooHome = ownerOperatorHome(), claudeDir = claudeConfigDir()): HookInstallStatus {
  const command = writeScript(ooHome);
  const path = settingsPath(claudeDir);
  mkdirSync(claudeDir, { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  writeFileSync(path, mergeClaudeHookSettings(current, command));
  return hookStatus(ooHome, claudeDir);
}

export function uninstallClaudeHooks(ooHome = ownerOperatorHome(), claudeDir = claudeConfigDir()): HookInstallStatus {
  const path = settingsPath(claudeDir);
  if (existsSync(path)) writeFileSync(path, removeClaudeHookSettings(readFileSync(path, "utf8")));
  rmSync(hookScriptPath(ooHome), { force: true });
  return hookStatus(ooHome, claudeDir);
}

export function hookStatus(ooHome = ownerOperatorHome(), claudeDir = claudeConfigDir()): HookInstallStatus {
  const path = settingsPath(claudeDir);
  const settingsText = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    script: existsSync(hookScriptPath(ooHome)) ? "installed" : "missing",
    scriptPath: hookScriptPath(ooHome),
    settings: !existsSync(path) ? "absent" : settingsText.includes(MANAGED_HOOK_MARKER) ? "installed" : "missing",
    settingsPath: path,
    endpoint: existsSync(hookEndpointPath(ooHome)) ? "published" : "missing",
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

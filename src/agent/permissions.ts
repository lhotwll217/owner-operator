import {
  gitValueFlags,
  parseShellCommand,
  type SimpleCommand,
} from "@thurstonsand/pi-permissions";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadBlacklist, loadHarnessSettings, ownerOperatorPaths } from "@owner-operator/core";
import {
  blacklistedBashReason,
  blacklistedDescendantVerdict,
  blacklistedPathVerdict,
  shellAssignmentCanExecute,
} from "./privacy-tools";
import { repoRoot } from "../shared/repo-root";

export type OwnerOperatorGateSurface = "interactive" | "headless";
export interface OwnerOperatorToolCall {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  ooHome?: string;
  surface: OwnerOperatorGateSurface;
}
export interface OwnerOperatorGateDecision {
  action: "allow" | "ask" | "deny";
  reason?: string;
}

const ALWAYS_SAFE = new Set([
  "[", "basename", "cat", "cd", "command", "cut", "date", "df", "diff", "dirname",
  "du", "echo", "env", "false", "file", "find", "grep", "head", "jq", "ls", "pwd",
  "printf", "printenv", "readlink", "realpath", "rg", "sed", "sleep", "sort", "stat",
  "tail", "test", "tr", "true", "type", "uname", "uniq", "wc", "which", "whoami",
]);
const SHELL_WRAPPERS = new Set(["bash", "dash", "sh", "zsh"]);
const SAFE_GIT = new Set(["blame", "describe", "diff", "grep", "log", "ls-files", "rev-parse", "show", "status"]);
const RISKY_GIT_FLAGS = new Set([
  "-c", "--config-env", "--exec-path", "--ext-diff", "--textconv", "--open-files-in-pager", "--output",
]);
const OUTPUT_REDIRECTION = /(^|[^<])(?:>>?|&>)/;

function commandIsSafe(command: SimpleCommand): boolean {
  if (command.assignments.some((assignment) => shellAssignmentCanExecute(assignment.text))) return false;
  const program = command.programName;
  if (!program) return false;
  if (SHELL_WRAPPERS.has(program)) return command.hasFlag("-c");
  if (program === "git") {
    if (command.args.some((arg) => RISKY_GIT_FLAGS.has(arg.text) || [...RISKY_GIT_FLAGS].some((flag) => arg.text.startsWith(`${flag}=`)))) return false;
    const subcommand = command.subcommand({ valueFlags: gitValueFlags })?.text;
    return !!subcommand && SAFE_GIT.has(subcommand);
  }
  if (program === "node") {
    if (command.assignments.some((assignment) => assignment.text.startsWith("OO_INSTALL_ROOT="))) return false;
    const script = command.positionals()[0]?.text;
    return script === "$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs" ||
      script === "${OO_INSTALL_ROOT}/src/agent/skills/session-search/scripts/session-search.mjs" ||
      script === `${repoRoot}/src/agent/skills/session-search/scripts/session-search.mjs`;
  }
  if (program === "sed" && command.hasFlag("-i", "--in-place")) return false;
  if (program === "find" && command.args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg.text))) return false;
  return ALWAYS_SAFE.has(program);
}

async function bashIsSafe(command: string): Promise<boolean> {
  if (OUTPUT_REDIRECTION.test(command) || /\b(?:sudo|doas)\b/.test(command)) return false;
  const parsed = await parseShellCommand(command);
  return !parsed.hasErrors && parsed.commands.length > 0 && parsed.commands.every(commandIsSafe);
}

function rawPath(input: Record<string, unknown>): string {
  return typeof input.path === "string" && input.path.trim() ? input.path : ".";
}

export async function evaluateOwnerOperatorToolCall(call: OwnerOperatorToolCall): Promise<OwnerOperatorGateDecision> {
  const blacklist = loadBlacklist(ownerOperatorPaths(call.ooHome).home);
  if (["read", "grep", "find", "ls", "edit", "write"].includes(call.toolName)) {
    const path = rawPath(call.input);
    const direct = blacklistedPathVerdict(path, call.cwd, blacklist);
    if (direct.blacklisted) return { action: "deny", reason: `Privacy blacklist denies access to ${direct.path}` };
    if (["grep", "find", "ls"].includes(call.toolName)) {
      const descendant = blacklistedDescendantVerdict(path, call.cwd, blacklist);
      if (descendant.blacklisted) return { action: "deny", reason: `Privacy blacklist denies traversal of ${descendant.root}` };
    }
  }
  const settings = loadHarnessSettings(call.ooHome);
  if (call.toolName === "edit" || call.toolName === "write") {
    const action = settings.gatePolicy[call.surface][call.toolName];
    return { action, ...(action === "deny" ? { reason: `${call.toolName} is denied on ${call.surface} runs` } : {}) };
  }
  if (call.toolName !== "bash") return { action: "allow" };
  const command = typeof call.input.command === "string" ? call.input.command : "";
  const blacklistReason = await blacklistedBashReason(command, call.cwd, blacklist);
  if (blacklistReason) return { action: "deny", reason: blacklistReason };
  if (await bashIsSafe(command)) return { action: "allow" };
  const action = settings.gatePolicy[call.surface].riskyBash;
  return { action, ...(action === "deny" ? { reason: `Risky bash is denied on ${call.surface} runs` } : {}) };
}

export function createOwnerOperatorPermissionExtension(options: {
  surface: OwnerOperatorGateSurface;
  ooHome?: string;
}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const decision = await evaluateOwnerOperatorToolCall({
        toolName: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
        ooHome: options.ooHome,
        surface: options.surface,
      });
      if (decision.action === "allow") return undefined;
      if (decision.action === "deny" || !ctx.hasUI) {
        return { block: true, reason: decision.reason ?? "Owner approval is unavailable" };
      }
      const detail = event.toolName === "bash"
        ? String(event.input.command ?? "")
        : String((event.input as Record<string, unknown>).path ?? JSON.stringify(event.input));
      const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, detail);
      return approved ? undefined : { block: true, reason: `Owner rejected ${event.toolName}` };
    });
  };
}

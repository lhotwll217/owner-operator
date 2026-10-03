/** Environment that names the coding session invoking `oo`, in precedence order: an explicit
 * `OO_FROM_SESSION`, then the harness's own session id. Codex exports `CODEX_THREAD_ID`, Claude Code
 * `CLAUDE_CODE_SESSION_ID`, and the Cursor agent `CURSOR_CONVERSATION_ID` (undocumented; set per
 * shell command by its runner, equal to its ACP session id). OpenCode exports no session id. */
export const CALLER_SESSION_ENV = ["OO_FROM_SESSION", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CURSOR_CONVERSATION_ID"] as const;

/** The coding session invoking `oo`, when it identifies itself: an explicit `--from-session`, then
 * `CALLER_SESSION_ENV`. */
export function callerSessionId(explicit?: string): string | undefined {
  return [explicit, ...CALLER_SESSION_ENV.map((name) => process.env[name])]
    .find((value) => typeof value === "string" && value.trim())?.trim();
}

/** The session a delegated run belongs to and reports back to: an explicit id, then the Operator
 * session whose own bash is running `oo` (`OO_CURRENT_SESSION_ID`, exported by the privacy guard in
 * src/agent/privacy-tools.ts), then the calling coding session. `callerSessionId` stays separate
 * because search keeps the current Operator session and its caller apart. */
export function parentSessionId(explicit?: string): string | undefined {
  return explicit?.trim() || process.env.OO_CURRENT_SESSION_ID?.trim() || callerSessionId();
}

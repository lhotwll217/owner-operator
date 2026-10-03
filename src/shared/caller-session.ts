/** The coding session invoking `oo`, when it identifies itself: an explicit `--from-session`,
 * then `OO_FROM_SESSION`, then the harness's own session env (Codex exports `CODEX_THREAD_ID`). */
export function callerSessionId(explicit?: string): string | undefined {
  return [explicit, process.env.OO_FROM_SESSION, process.env.CODEX_THREAD_ID]
    .find((value) => typeof value === "string" && value.trim())?.trim();
}

/** The session a delegated run belongs to and reports back to: an explicit id, then the Operator
 * session whose own bash is running `oo` (`OO_CURRENT_SESSION_ID`, exported by the privacy guard in
 * src/agent/privacy-tools.ts), then the calling coding session. `callerSessionId` stays separate
 * because search keeps the current Operator session and its caller apart. */
export function parentSessionId(explicit?: string): string | undefined {
  return explicit?.trim() || process.env.OO_CURRENT_SESSION_ID?.trim() || callerSessionId();
}

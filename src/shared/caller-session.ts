/** The coding session invoking `oo`, when it identifies itself: an explicit `--from-session`,
 * then `OO_FROM_SESSION`, then the harness's own session env (Codex exports `CODEX_THREAD_ID`). */
export function callerSessionId(explicit?: string): string | undefined {
  return [explicit, process.env.OO_FROM_SESSION, process.env.CODEX_THREAD_ID]
    .find((value) => typeof value === "string" && value.trim())?.trim();
}

/** The session a delegated run belongs to and reports back to. Inside the Operator's own bash the
 * privacy guard (src/agent/privacy-tools.ts) exports `OO_CURRENT_SESSION_ID`, and it wins over any
 * `--from-session` the model passes, so the help never invites a model to pick its own parent. A
 * model can still override the variable in its command; only delegate_agent, which reads Pi's
 * session, is unforgeable (adr/0001-agent-uses-its-own-cli.md). Outside an Operator, the explicit
 * flag, then the calling coding session.
 * `callerSessionId` stays separate because search keeps the current Operator session and its
 * caller apart. */
export function parentSessionId(explicit?: string): string | undefined {
  return process.env.OO_CURRENT_SESSION_ID?.trim() || explicit?.trim() || callerSessionId();
}

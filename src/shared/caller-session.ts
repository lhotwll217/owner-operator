/** The coding session invoking `oo`, when it identifies itself: an explicit `--from-session`,
 * then `OO_FROM_SESSION`, then the harness's own session env (Codex exports `CODEX_THREAD_ID`). */
export function callerSessionId(explicit?: string): string | undefined {
  return [explicit, process.env.OO_FROM_SESSION, process.env.CODEX_THREAD_ID]
    .find((value) => typeof value === "string" && value.trim())?.trim();
}

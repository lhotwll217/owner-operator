export const agentCaller = (): boolean =>
  process.env.OO_AGENT === "1" || Boolean(process.env.OO_AGENT_RUN_LEASE_ID);

/** Only a root Operator's bash may prompt a fresh Operator on the running daemon. */
export function childPromptParent(): string | undefined {
  if (process.env.OO_AGENT !== "1" || process.env.OO_CAN_PROMPT !== "1" || process.env.OO_AGENT_RUN_LEASE_ID) {
    return undefined;
  }
  return process.env.OO_CURRENT_SESSION_ID?.trim() || undefined;
}

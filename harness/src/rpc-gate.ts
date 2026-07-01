// The command allowlist for `oo --rpc`. Only read-only / prompting commands reach pi's
// runRpcMode; everything else — including unknown or future mutating commands — is rejected, so
// the channel stays read-only as pi's RPC protocol grows. (An allowlist, deliberately, not a
// denylist of today's dangerous commands.)
export const ALLOWED_RPC_COMMANDS = new Set([
  "prompt", "steer", "follow_up", "abort", "abort_retry",
  "get_state", "get_last_assistant_text", "get_messages", "get_session_stats",
  "get_commands", "get_available_models", "get_fork_messages",
]);

export type GateDecision = { forward: true } | { forward: false; response: string };

// Decide whether a raw stdin line should reach runRpcMode. Unparseable JSON is forwarded so
// runRpcMode reports the protocol error itself. A listed command is forwarded. Anything else
// (mutating, shell, session-control, or unknown) gets a JSON-RPC error response and is dropped.
export function classifyRpcLine(line: string): GateDecision {
  let cmd: { type?: unknown; id?: unknown };
  try {
    cmd = JSON.parse(line);
  } catch {
    return { forward: true };
  }
  const type = typeof cmd?.type === "string" ? cmd.type : undefined;
  if (type && ALLOWED_RPC_COMMANDS.has(type)) return { forward: true };
  const id = typeof cmd?.id === "string" ? cmd.id : undefined;
  const response = JSON.stringify({
    ...(id !== undefined ? { id } : {}),
    type: "response",
    command: type ?? null,
    success: false,
    error: `${type ?? "command"} is not allowed on oo --rpc (read-only channel)`,
  });
  return { forward: false, response };
}

// Injected/boilerplate turns are transcript transport context, not user-facing topics.
// Shared by discovery and the durable-state projection so a newly-added rule also hides
// legacy rows already stored in SQLite.
const SESSION_BOILERPLATE = [
  /^Respond directly to the user'?s prompt/i,
  /^<system_instruction>/i,
  /^<environment_context>/i,
  /^<recommended_plugins>/i,
  /^<user_instructions>/i,
  /^<user_action>/i,
  /^<turn_aborted>/i,
  /^# AGENTS\.md/i,
  /Use the [\w-]+ worker role/i,
  /^Review the current code changes/i,
  /^Remember this token/i,
  /^\(Empty session\)/i,
  /A session-scoped Stop hook is now active/i,
];

export function isSessionBoilerplate(text) {
  const value = String(text ?? "").trim();
  return !value || SESSION_BOILERPLATE.some((pattern) => pattern.test(value));
}

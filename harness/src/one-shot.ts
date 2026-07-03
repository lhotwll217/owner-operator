// Owner Operator — `oo one-shot "<question>"`: the agent-to-agent channel as a single
// invocation. Same neutral read-only session as `oo --rpc` (agent-rpc prompt, no shell,
// scan/search skills), but one prompt in → the assistant's final text on stdout → exit.
// No protocol to speak, no channel to hold open; the caller never reaches pi's RPC
// commands, so there is nothing for the rpc-gate to vet.
//
// The thread persists ON DISK (the claude -p --resume / codex exec resume pattern):
// each run appends to a pi session file under <ooHome>/agent-sessions — a dedicated dir,
// NOT ~/.pi/agent/sessions, so the poller never triages oo's own agent-to-agent chatter —
// and prints its session id on stderr. Chain calls with --continue (most recent) or
// --session <id>. Resumes are sequential; concurrent appends to one session are not
// supported (pi makes no locking guarantee).
import { runPrintMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createNeutralAgentRuntime, repoRoot } from "./agent";
import { parseOneShotArgs } from "./one-shot-args";

const USAGE = `usage: oo one-shot [--continue | --session <id-or-path>] "<question>"
  --continue, -c      resume the most recent agent thread
  --session <id>      resume a specific thread (id prefix or session-file path)
Prints the answer on stdout and the thread's session id on stderr.`;

const args = parseOneShotArgs(process.argv.slice(2));
if (!args.prompt) {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

const sessionsDir = join(process.env.OO_HOME ?? join(homedir(), ".owner-operator"), "agent-sessions");

// Same resolution rules as pi's own --session: path-like → open the file, otherwise match
// a session id (exact, then prefix) — but only within oo's agent-sessions dir.
async function resolveSessionManager(): Promise<SessionManager> {
  const ref = args.session;
  if (ref !== undefined) {
    if (!ref) {
      process.stderr.write("--session needs an id or path\n" + USAGE + "\n");
      process.exit(2);
    }
    if (ref.includes("/") || ref.endsWith(".jsonl") || isAbsolute(ref)) return SessionManager.open(resolve(ref), sessionsDir);
    const sessions = await SessionManager.list(repoRoot, sessionsDir);
    const match = sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.id.startsWith(ref));
    if (!match) {
      process.stderr.write(`no agent session matching "${ref}" in ${sessionsDir}\n`);
      process.exit(2);
    }
    return SessionManager.open(match.path, sessionsDir);
  }
  if (args.continue) return SessionManager.continueRecent(repoRoot, sessionsDir);
  return SessionManager.create(repoRoot, sessionsDir);
}

const sessionManager = await resolveSessionManager();
const runtime = await createNeutralAgentRuntime(sessionManager);
const code = await runPrintMode(runtime, { mode: "text", initialMessage: args.prompt });
// The chaining key, on stderr so stdout stays the pure answer channel.
process.stderr.write(`[oo one-shot] session ${sessionManager.getSessionId()}\n`);
process.exit(code);

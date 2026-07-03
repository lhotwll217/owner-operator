// Owner Operator — `oo one-shot "<question>"`: THE agent-to-agent channel. A neutral
// read-only session (agent-channel prompt, no shell, scan/search skills), one prompt in →
// the assistant's final text on stdout → exit. No protocol to speak, no channel to hold
// open; read-only is enforced at the tool layer (neutralAgentTools has no bash/edit/write).
//
// The thread persists ON DISK (the claude -p --resume / codex exec resume pattern):
// each run appends to a pi session file in oo's own sessions dir — never
// ~/.pi/agent/sessions, so the poller never triages oo's own threads — and prints its
// session id on stderr. Chain calls with --continue (most recent) or --session <id>.
// Every invocation (including resumes) stamps surface=one-shot provenance with the
// caller's cwd/repo, plus the calling session's id when given via --from-session — the
// audit trail. The dir and its managers are owned by agent.ts (oo's persistence policy);
// this file only picks WHICH thread. Resumes are sequential; concurrent appends to one
// session are not supported (pi makes no locking guarantee).
import { runPrintMode, type SessionManager } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import {
  continueOoSession,
  createNeutralAgentRuntime,
  createOoSession,
  listOoSessions,
  ooProvenance,
  ooSessionsDir,
  openOoSession,
} from "./agent";
import { parseOneShotArgs } from "./one-shot-args";

const USAGE = `usage: oo one-shot [--continue | --session <id-or-path>] [--from-session <id>] "<question>"
  --continue, -c        resume the most recent agent thread
  --session <id>        resume a specific thread (id prefix or session-file path)
  --from-session <id>   audit: record which coding session is making this call
Prints the answer on stdout and the thread's session id on stderr.`;

const args = parseOneShotArgs(process.argv.slice(2));
if (!args.prompt) {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

const provenance = ooProvenance("one-shot", args.fromSession);

// Same resolution rules as pi's own --session: path-like → open the file, otherwise match
// a session id (exact, then prefix) — but only among oo's own threads.
async function resolveSessionManager(): Promise<SessionManager> {
  const ref = args.session;
  if (ref !== undefined) {
    if (!ref) {
      process.stderr.write("--session needs an id or path\n" + USAGE + "\n");
      process.exit(2);
    }
    if (ref.includes("/") || ref.endsWith(".jsonl") || isAbsolute(ref)) return openOoSession(resolve(ref), provenance);
    const sessions = await listOoSessions();
    const match = sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.id.startsWith(ref));
    if (!match) {
      process.stderr.write(`no agent session matching "${ref}" in ${ooSessionsDir()}\n`);
      process.exit(2);
    }
    return openOoSession(match.path, provenance);
  }
  if (args.continue) return continueOoSession(provenance);
  return createOoSession(provenance);
}

const sessionManager = await resolveSessionManager();
const runtime = await createNeutralAgentRuntime(sessionManager);
const code = await runPrintMode(runtime, { mode: "text", initialMessage: args.prompt });
// The chaining key, on stderr so stdout stays the pure answer channel.
process.stderr.write(`[oo one-shot] session ${sessionManager.getSessionId()}\n`);
process.exit(code);

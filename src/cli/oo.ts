// Owner Operator — plain frontend (readline REPL + headless single-turn). Normal turns are prose.
// Session-state mode returns the current model-free gateway/widget state.
// Agent core: agent.ts.
//
//   tsx src/cli/oo.ts                            # interactive (plain)
//   tsx src/cli/oo.ts "what's ongoing?"          # headless single-turn, prose
//   tsx src/cli/oo.ts --continue "and then?"     # resume most recent oo thread
//   tsx src/cli/oo.ts --session <id> "and then?" # resume a specific oo thread
//   tsx src/cli/oo.ts --session-state            # current session state snapshot

import readline from "node:readline/promises";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { parseOoArgs } from "./oo-args";

const USAGE = `Owner Operator (oo) — read & triage your local CLI agent sessions.

  oo                         pi's stock interactive mode
  oo -i | --interactive      alias for the default interactive mode
  oo "what's ongoing?"       headless single-turn question (prose)
  oo --continue "and then?"  resume the most recent oo thread
  oo --session <id> "more"   resume a specific oo thread
  oo --from-session <id>     audit: record which coding session is calling
  oo --session-state         current session state snapshot
  oo daemon                  run the state-owning daemon
  oo --help | -h             this help

Model: OO_MODEL or .pi/settings.json (default: codex gpt-5.5)`;

const cli = parseOoArgs(process.argv.slice(2));

// --help / -h: usage and exit BEFORE building a model session, so probing help never makes a
// paid call.
if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}

// `oo daemon` — run the state-owning daemon (no model session needed). Resolves on shutdown.
if (cli.daemon) {
  const { daemonMain } = await import("../gateway/daemon");
  await daemonMain();
  process.exit(0);
}

if (cli.removedJson) {
  process.stderr.write("oo: --json was renamed to --session-state\n");
  process.exit(2);
}

if (cli.removedHeadlessSubcommand) {
  process.stderr.write("oo: that removed headless subcommand has been removed; use `oo \"question\"` for headless prose or `oo --session-state` for the model-free state snapshot\n");
  process.exit(2);
}

if (cli.missingSession) {
  process.stderr.write("--session needs an id or path\n" + USAGE + "\n");
  process.exit(2);
}

if (cli.missingFromSession) {
  process.stderr.write("--from-session needs an id\n" + USAGE + "\n");
  process.exit(2);
}

if (cli.interactive) {
  if (cli.continue || cli.session || cli.fromSession || cli.prompt) {
    process.stderr.write("oo: -i/--interactive is only valid by itself; use bare `oo` for interactive mode\n");
    process.exit(2);
  }
  await import("./interactive");
  process.exit(0);
}

if (cli.sessionState) {
  const { getCurrentSessionStateRows } = await import("../gateway/session-state");
  process.stdout.write(JSON.stringify(await getCurrentSessionStateRows(), null, 2) + "\n");
  process.exit(0);
}

const {
  continueOoSession,
  createOoSession,
  createOwnerOperatorSession,
  lastAssistantText,
  listOoSessions,
  ooProvenance,
  ooSessionsDir,
  openOoSession,
  shutdownSessionExtensions,
} = await import("../agent/agent");

const provenance = ooProvenance("chat", cli.fromSession);

async function resolveSessionManager(): Promise<SessionManager> {
  const ref = cli.session;
  if (ref !== undefined) {
    if (!ref) {
      process.stderr.write("--session needs an id or path\n" + USAGE + "\n");
      process.exit(2);
    }
    if (ref.includes("/") || ref.endsWith(".jsonl") || isAbsolute(ref)) return openOoSession(resolve(ref), provenance);
    const sessions = await listOoSessions();
    const match = sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.id.startsWith(ref));
    if (!match) {
      process.stderr.write(`no oo session matching "${ref}" in ${ooSessionsDir()}\n`);
      process.exit(2);
    }
    return openOoSession(match.path, provenance);
  }
  if (cli.continue) return continueOoSession(provenance);
  return createOoSession(provenance);
}

const sessionManager = await resolveSessionManager();
const { session, skills, modelLabel } = await createOwnerOperatorSession("chat", { sessionManager });
console.error(`[oo] ${modelLabel} · skills: ${skills.map((s) => s.name).join(", ")}\n`);

const headlessPrompt = cli.prompt;

const DEBUG = !!process.env.OO_DEBUG;

let streamed = false;
session.subscribe((event: any) => {
  const ame = event.assistantMessageEvent;
  if (event.type === "message_update" && ame?.type === "text_delta") {
    streamed = true;
    process.stdout.write(ame.delta);
  } else if (DEBUG) {
    process.stderr.write(`\n[ev] ${event.type}${ame?.type ? ":" + ame.type : ""}`);
  }
});

function emitTurn(): void {
  if (!streamed) process.stdout.write(lastAssistantText(session) || "[oo] (no assistant text)");
}

async function runTurn(q: string): Promise<void> {
  streamed = false;
  try {
    await session.prompt(q);
  } catch (e: any) {
    process.stderr.write(`\n[oo] error: ${e?.stack ?? e?.message ?? e}\n`);
    return;
  }
  emitTurn();
}
try {
  if (headlessPrompt) {
    await runTurn(headlessPrompt);
    process.stderr.write(`[oo] session ${sessionManager.getSessionId()}\n`);
    process.stdout.write("\n");
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("Owner Operator — ask what's ongoing. /exit to quit.\n");
    for (;;) {
      const q = (await rl.question("oo› ")).trim();
      if (!q) continue;
      if (q === "/exit" || q === "/quit") break;
      await runTurn(q);
      process.stdout.write("\n\n");
    }
    rl.close();
  }
} finally {
  await shutdownSessionExtensions(session); // cron auto-cleanup etc. — dispose alone never emits it
  session.dispose();
}

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
import { appendFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseOoArgs } from "./oo-args";

const USAGE = `Owner Operator (oo) — track and act on your local CLI agent sessions.

  oo                         pi's stock interactive mode
  oo -i | --interactive      alias for the default interactive mode
  oo "what's ongoing?"       headless single-turn question (prose)
  oo --continue "and then?"  resume the most recent oo thread
  oo --session <id> "more"   resume a specific oo thread
  oo --from-session <id>     audit: record which coding session is calling
  oo --session-state         current session state snapshot
  oo --done <id...>          mark threads done by id (model-free; ids from --session-state)
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
  const { daemonMain } = await import("../daemon/runtime");
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
  await (await import("../daemon/ensure")).ensureDaemon();
  await import("./interactive");
  process.exit(0);
}

if (cli.sessionState) {
  await (await import("../daemon/ensure")).ensureDaemon();
  const { getCurrentSessionStateRows } = await import("../gateway/session-state");
  process.stdout.write(JSON.stringify(await getCurrentSessionStateRows(), null, 2) + "\n");
  process.exit(0);
}

// --done — model-free mark-done, the write twin of --session-state. Explicit ids only:
// coding agents get theirs from --session-state; no env or cwd guessing, so a parallel
// agent in the same repo can never mark a sibling's session by accident.
if (cli.done) {
  if (cli.done.length === 0) {
    process.stderr.write("--done needs one or more thread ids (see oo --session-state)\n" + USAGE + "\n");
    process.exit(2);
  }
  await (await import("../daemon/ensure")).ensureDaemon();
  const { resolveBackend } = await import("../gateway/client");
  const backend = await resolveBackend();
  const result = await backend.markDone(cli.done);
  backend.close();
  process.stdout.write(JSON.stringify({
    marked: result.marked,
    alreadyDoneIds: result.alreadyDoneIds,
    missingIds: result.missingIds,
  }, null, 2) + "\n");
  process.exit(result.missingIds.length > 0 ? 1 : 0);
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
  ownerOperatorTools,
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
await (await import("../daemon/ensure")).ensureDaemon();
const { session, modelLabel } = await createOwnerOperatorSession("chat", { sessionManager });
console.error(`[oo] ${modelLabel} · tools: ${ownerOperatorTools.join(", ")}\n`);

const headlessPrompt = cli.prompt;

const DEBUG = !!process.env.OO_DEBUG;

// OO_TRACE — machine-readable run trace for harnesses (the eval provider): one NDJSON
// line per tool call/result and per assistant turn (token usage + cost). A path appends
// to that file; "1" writes to stderr. Prose on stdout is unchanged either way.
const TRACE = process.env.OO_TRACE;
const traceLine = !TRACE
  ? null
  : (record: Record<string, unknown>): void => {
      const line = JSON.stringify(record) + "\n";
      if (TRACE === "1") process.stderr.write(line);
      else appendFileSync(TRACE, line);
    };

let streamed = false;
session.subscribe((event: any) => {
  const ame = event.assistantMessageEvent;
  if (event.type === "message_update" && ame?.type === "text_delta") {
    streamed = true;
    process.stdout.write(ame.delta);
  } else if (DEBUG) {
    process.stderr.write(`\n[ev] ${event.type}${ame?.type ? ":" + ame.type : ""}`);
  }
  if (!traceLine) return;
  if (event.type === "tool_execution_start") {
    traceLine({ event: "tool_call", id: event.toolCallId, tool: event.toolName, args: event.args });
  } else if (event.type === "tool_execution_end") {
    const resultChars = JSON.stringify(event.result?.content ?? event.result ?? "").length;
    traceLine({ event: "tool_result", id: event.toolCallId, tool: event.toolName, isError: event.isError, resultChars });
  } else if (event.type === "message_end" && event.message?.role === "assistant") {
    const { usage, stopReason } = event.message;
    traceLine({ event: "turn", stopReason, usage });
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
  await shutdownSessionExtensions(session); // dispose alone never emits the extension lifecycle
  session.dispose();
}

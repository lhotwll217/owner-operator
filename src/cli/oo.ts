// Owner Operator — `oo` entrypoint. Operations (`oo <noun> <verb>`) are model-free Gateway
// calls; `-p` runs one headless model turn; bare resume flags open the plain readline REPL.
// Agent core: agent.ts.
//
//   tsx src/cli/oo.ts                             # interactive (plain)
//   tsx src/cli/oo.ts -p "what's ongoing?"        # headless single-turn, prose
//   tsx src/cli/oo.ts --continue -p "and then?"   # resume most recent oo thread
//   tsx src/cli/oo.ts session-state list --json   # model-free operation

import readline from "node:readline/promises";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureOwnerOperatorWorkspace, isOnboarded } from "@owner-operator/core";
import { appendFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { OPERATION_NOUNS, parseOoArgs } from "./oo-args";

const USAGE = `Owner Operator (oo) — track and act on your local CLI agent sessions.

  oo                              embedded Pi interactive mode
  oo -p | --prompt "<text>"       one headless turn (prose on stdout, session id on stderr)
  oo --continue [-p "<text>"]     resume the most recent oo thread
  oo --session <id> [-p "<text>"] resume a specific oo thread
  oo --from-session <id>          record which coding session is calling
  oo doctor | status              effective workspace, resources, credentials, and gates
  oo daemon                       run the state-owning daemon
  oo --help | -h                  this help

Operations (model-free; \`oo <noun> --help\` shows each noun's usage; --json gives machine-readable output):
${OPERATION_NOUNS.map((noun) => `  oo ${noun}${noun === "search" ? "            flags only, no verbs; --help prints the search flags" : ""}`).join("\n")}

Model: imported or configured under OO_HOME/pi/settings.json`;

const cli = parseOoArgs(process.argv.slice(2));
const harnessPaths = ensureOwnerOperatorWorkspace();

// Help, usage errors, and operations exit BEFORE building a model session, so probing the CLI
// never makes a paid call.
if (cli.kind === "help") {
  console.log(USAGE);
  process.exit(0);
}

if (cli.kind === "usage-error") {
  process.stderr.write(`oo: ${cli.message}\n\n${USAGE}\n`);
  process.exit(2);
}

if (cli.kind === "doctor") {
  const { formatHarnessDoctor } = await import("../agent/doctor");
  const output = formatHarnessDoctor();
  process.stdout.write(output);
  await (await import("./operations/operation")).flushStdio();
  process.exit(output.startsWith("Status: ready") ? 0 : 1);
}

// `oo daemon` — run the state-owning daemon (no model session needed). Resolves on shutdown.
if (cli.kind === "daemon") {
  const { daemonMain } = await import("../daemon/runtime");
  await daemonMain();
  process.exit(0);
}

if (cli.kind === "operation") {
  const { runOperation } = await import("./operations");
  const { flushStdio } = await import("./operations/operation");
  const code = await runOperation(cli.noun, cli.argv);
  await flushStdio();
  process.exit(code);
}

if (cli.kind === "interactive") {
  await (await import("../daemon/ensure")).ensureDaemon();
  await import("./interactive");
  process.exit(0);
}

// Remaining form: a plain oo conversation, one headless turn with -p or the readline REPL.
const chat = cli;

if (!isOnboarded(harnessPaths.home)) {
  process.stderr.write("oo: setup required; run `oo` in an interactive terminal\n");
  process.exit(2);
}

const {
  continueOoSession,
  createOoSession,
  createOwnerOperatorSession,
  lastAssistantError,
  lastAssistantText,
  listOoSessions,
  ooProvenance,
  ooSessionsDir,
  openOoSession,
  shutdownSessionExtensions,
} = await import("../agent/agent");

const provenance = ooProvenance("chat", chat.fromSession);

async function resolveSessionManager(): Promise<SessionManager> {
  const ref = chat.session;
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
  if (chat.continue) return continueOoSession(provenance);
  return createOoSession(provenance);
}

const sessionManager = await resolveSessionManager();
await (await import("../daemon/ensure")).ensureDaemon();
const { resolveOwnerOperatorTaskCwd } = await import("../agent/worktree-runtime");
const cwd = await resolveOwnerOperatorTaskCwd(
  sessionManager,
  (await import("../agent/agent")).ownerOperatorTaskCwd(),
);
const { session, modelLabel, toolNames } = await createOwnerOperatorSession("chat", {
  sessionManager,
  cwd,
  callerSessionId: provenance.fromSession,
});
console.error(`[oo] ${modelLabel} · tools: ${toolNames.join(", ")}\n`);

const headlessPrompt = chat.prompt;

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
    const { usage, stopReason, errorMessage } = event.message;
    traceLine({ event: "turn", stopReason, usage, ...(errorMessage ? { errorMessage } : {}) });
  }
});

function emitTurn(): void {
  if (!streamed) process.stdout.write(lastAssistantText(session) || "[oo] (no assistant text)");
}

async function runTurn(q: string): Promise<boolean> {
  streamed = false;
  try {
    await session.prompt(q);
  } catch (e: any) {
    process.stderr.write(`\n[oo] error: ${e?.stack ?? e?.message ?? e}\n`);
    return false;
  }
  const error = lastAssistantError(session);
  if (error) {
    process.stderr.write(`\n[oo] error: ${error}\n`);
    return false;
  }
  emitTurn();
  return true;
}
try {
  if (headlessPrompt) {
    const ok = await runTurn(headlessPrompt);
    process.stderr.write(`[oo] session ${sessionManager.getSessionId()}\n`);
    process.stdout.write("\n");
    if (!ok) process.exitCode = 1;
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

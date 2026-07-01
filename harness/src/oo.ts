// Owner Operator — plain frontend (readline REPL + one-shot). A CONSUMER of the headless
// triage data (Thread[] from @owner-operator/core); renders it as cards, or as raw JSON
// with --json. Agent core: agent.ts.
//
//   tsx src/oo.ts                            # interactive (plain)
//   tsx src/oo.ts "what's ongoing?"          # one-shot, terminal cards
//   tsx src/oo.ts --json "what's ongoing?"   # one-shot, headless JSON snapshot

import readline from "node:readline/promises";
import { createOwnerOperatorSession, lastAssistantText } from "./agent";
import { parseOoArgs } from "./oo-args";
import type { Thread } from "@owner-operator/core";
import { buildCardsBlock } from "./cards";

const USAGE = `Owner Operator (oo) — read & triage your local CLI agent sessions.

  oo                         branded TUI (interactive)
  oo -i | --interactive      pi's stock interactive mode
  oo "what's ongoing?"       one-shot question (cards)
  oo --json "what needs me"  one-shot, headless JSON snapshot
  oo daemon                  run the state-owning daemon
  oo --rpc                   headless JSON-RPC on stdin/stdout (for agents)
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
  const { daemonMain } = await import("./daemon");
  await daemonMain();
  process.exit(0);
}

const { session, skills, modelLabel } = await createOwnerOperatorSession();
console.error(`[oo] ${modelLabel} · skills: ${skills.map((s) => s.name).join(", ")}\n`);

const jsonMode = cli.json;
const oneShot = cli.prompt;

const DEBUG = !!process.env.OO_DEBUG;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Cards are one renderer over the triage data. (--json emits the raw Thread[] instead.)
function renderCards(threads: Thread[]): void {
  for (const line of buildCardsBlock(threads, process.stdout.columns ?? 80)) {
    process.stdout.write((process.stdout.isTTY ? line : stripAnsi(line)) + "\n");
  }
}

let streamed = false;
let presented = false;
let lastThreads: Thread[] = [];
session.subscribe((event: any) => {
  // Capture the triage DATA; don't render here — the surface decides how at turn's end.
  if (event.type === "tool_execution_start" && event.toolName === "present_threads") {
    presented = true;
    lastThreads = (event.args?.threads ?? []) as Thread[];
    return;
  }
  const ame = event.assistantMessageEvent;
  if (event.type === "message_update" && ame?.type === "text_delta") {
    streamed = true;
    if (!jsonMode) process.stdout.write(ame.delta); // prose streams to the human only
  } else if (DEBUG) {
    process.stderr.write(`\n[ev] ${event.type}${ame?.type ? ":" + ame.type : ""}`);
  }
});

function emitTurn(): void {
  if (jsonMode) {
    // Headless data contract: the triage as JSON (empty array if the turn wasn't a triage).
    process.stdout.write(JSON.stringify(lastThreads, null, 2) + "\n");
    return;
  }
  if (presented) return renderCards(lastThreads);       // cards: one renderer over the data
  if (!streamed) process.stdout.write(lastAssistantText(session) || "[oo] (no assistant text)");
}

async function runTurn(q: string): Promise<void> {
  streamed = false;
  presented = false;
  lastThreads = [];
  try {
    await session.prompt(q);
  } catch (e: any) {
    process.stderr.write(`\n[oo] error: ${e?.stack ?? e?.message ?? e}\n`);
    return;
  }
  emitTurn();
}
try {
  if (oneShot) {
    await runTurn(oneShot);
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
  session.dispose();
}

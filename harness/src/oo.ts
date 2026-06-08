// Owner Operator — plain frontend (readline REPL + one-shot). Agent core: agent.ts.
//
//   tsx src/oo.ts                    # interactive (plain)
//   tsx src/oo.ts "what's ongoing?"  # one-shot

import readline from "node:readline/promises";
import { createOwnerOperatorSession, lastAssistantText, type PresentedThread } from "./agent";
import { buildCardsBlock } from "./cards";

const { session, skills, modelLabel } = await createOwnerOperatorSession();
console.error(`[oo] ${modelLabel} · skills: ${skills.map((s) => s.name).join(", ")}\n`);

const DEBUG = !!process.env.OO_DEBUG;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Headless mirror of the TUI: the model presents triage via the `present_threads` tool call
// (structured output). The TUI draws cards; here we print the same buildCard() lines to
// stdout (stripping color when piped). Same payload, surface-appropriate rendering.
function renderCards(threads: PresentedThread[]): void {
  for (const line of buildCardsBlock(threads, process.stdout.columns ?? 80)) {
    process.stdout.write((process.stdout.isTTY ? line : stripAnsi(line)) + "\n");
  }
}

let streamed = false;
let presented = false;
session.subscribe((event: any) => {
  // Triage came back as structured cards → render them, not prose.
  if (event.type === "tool_execution_start" && event.toolName === "present_threads") {
    presented = true;
    renderCards(event.args?.threads ?? []);
    return;
  }
  const ame = event.assistantMessageEvent;
  if (event.type === "message_update" && ame?.type === "text_delta") {
    streamed = true;
    process.stdout.write(ame.delta);
  } else if (DEBUG) {
    process.stderr.write(`\n[ev] ${event.type}${ame?.type ? ":" + ame.type : ""}`);
  }
});

async function runTurn(q: string): Promise<void> {
  streamed = false;
  presented = false;
  try {
    await session.prompt(q);
  } catch (e: any) {
    process.stderr.write(`\n[oo] error: ${e?.stack ?? e?.message ?? e}\n`);
    return;
  }
  if (!streamed && !presented) process.stdout.write(lastAssistantText(session) || "[oo] (no assistant text)");
}

const oneShot = process.argv.slice(2).join(" ").trim();
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

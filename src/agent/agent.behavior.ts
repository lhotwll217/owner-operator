// Behavioral test — runs the REAL agent and asserts it can answer a session-state question in prose.
//   npm run test:agent      (needs model auth; makes a real model call)

import assert from "node:assert";
import { createOwnerOperatorSession } from "./agent";

const { session } = await createOwnerOperatorSession("chat", { ephemeral: true }); // a test run, not a real chat — keep it off disk
let text = "";
session.subscribe((event: any) => {
  const ame = event.assistantMessageEvent;
  if (event.type === "message_update" && ame?.type === "text_delta") text += ame.delta;
});

await session.prompt("what's ongoing? Answer in concise prose.");
try { session.dispose(); } catch { /* ignore */ }

process.stdout.write(`assistant text chars: ${text.length}\n`);
assert.ok(text.trim().length > 0, "agent must answer in prose");
process.stdout.write("\nok — agent answered session-state prompt in prose\n");
process.exit(0);

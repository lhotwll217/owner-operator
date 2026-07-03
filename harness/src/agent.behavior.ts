// Behavioral test — runs the REAL agent and asserts it produces a valid headless triage
// (the UI-independent Thread[] contract from @owner-operator/core), independent of any
// renderer. Intentionally NON-deterministic: it exercises the model, so it asserts the data
// CONTRACT, not exact content. (The terminal renderer is covered by cards.preview.ts.)
//   npm run test:agent      (needs model auth; makes a real model call)

import assert from "node:assert";
import { createOwnerOperatorSession } from "./agent";
import type { Thread } from "@owner-operator/core";

function assertThread(t: any, i: number): asserts t is Thread {
  assert.ok(t && typeof t === "object", `thread[${i}] is an object`);
  assert.equal(typeof t.topic, "string", `thread[${i}].topic is a string`);
  assert.ok(Number.isInteger(t.priority) && t.priority >= 1 && t.priority <= 5, `thread[${i}].priority is an int 1..5`);
  for (const f of ["summary", "nextSteps", "repo", "app", "created", "lastActive"]) {
    assert.equal(typeof t[f], "string", `thread[${i}].${f} is a string`);
  }
  if (t.link != null) assert.equal(typeof t.link, "string", `thread[${i}].link is a string when present`);
}

const { session } = await createOwnerOperatorSession("chat", { ephemeral: true }); // a test run, not a real chat — keep it off disk

let presented = false;
let threads: unknown[] = [];
session.subscribe((event: any) => {
  if (event.type === "tool_execution_start" && event.toolName === "present_threads") {
    presented = true;
    threads = event.args?.threads ?? [];
  }
});

await session.prompt("what's ongoing?");
try { session.dispose(); } catch { /* ignore */ }

process.stdout.write(`present_threads fired: ${presented}\nthreads: ${threads.length}\n`);

// --- the data contract (what every surface relies on) ---
assert.ok(presented, "agent must emit its triage as structured data via present_threads (not prose)");
assert.ok(Array.isArray(threads), "triage payload must be an array of Thread");
threads.forEach((t, i) => assertThread(t, i));

process.stdout.write(`\nok — agent emits a valid Thread[] triage (${threads.length} threads)\n`);
process.exit(0);

// Deterministic preview + test for thread-card rendering — no model, no TTY required.
//   npm run preview   (from harness/)
// Renders fixed sample threads through the same buildCardsBlock() the headless `oo` uses,
// then asserts the invariants (sort order, per-thread head line, empty case).

import assert from "node:assert";
import { buildCardsBlock } from "./cards";
import type { PresentedThread } from "./agent";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const sample: PresentedThread[] = [
  { topic: "Amplify 422 contract mismatch", priority: 3, summary: "POST/PATCH need a JSON body with source_updated_at; DELETE does not.", nextSteps: "Paste the drafted reply", repo: "amplify", app: "Claude Code", created: "1 hour ago", lastActive: "7 minutes ago" },
  { topic: "Headless triage card rendering", priority: 5, summary: "Headless oo now prints present_threads cards instead of no assistant text.", nextSteps: "Review the diff and push", repo: "owner-operator", app: "Claude Code", created: "just now", lastActive: "just now" },
  { topic: "Insights repo data refresh", priority: 1, summary: "Extracted the original CSV, verified against v2, updated the data README.", nextSteps: "Review changed files", repo: "amplify", app: "Codex", created: "30 minutes ago", lastActive: "27 minutes ago" },
];

const width = 80;
const block = buildCardsBlock(sample, width).map(stripAnsi);
process.stdout.write(block.join("\n") + "\n");

// --- invariants (fail loud on regression) ---
const heads = block.filter((l) => /^▌ P\d/.test(l));
assert.equal(heads.length, sample.length, "one head line per thread");
assert.match(heads[0], /P5/, "highest priority renders first");
assert.match(heads[heads.length - 1], /P1/, "lowest priority renders last");
assert.deepEqual(buildCardsBlock([], width).map(stripAnsi), ["(no active threads)"], "empty → notice");

process.stdout.write("\nok — card rendering preview passed\n");

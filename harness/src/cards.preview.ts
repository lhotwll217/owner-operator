// Deterministic test of the TERMINAL RENDERER only (not the agent). No model, no TTY.
//   npm run preview   (from harness/)
// Feeds fixed Thread data into buildCardsBlock() and asserts the rendering invariants
// (sort order, per-thread head line, empty case). Agent behavior is covered by test:agent.

import assert from "node:assert";
import { buildCardsBlock } from "./cards";
import type { Thread } from "@owner-operator/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const sample: Thread[] = [
  { topic: "Billing 422 contract mismatch", priority: 3, summary: "POST/PATCH need a JSON body with source_updated_at; DELETE does not.", nextSteps: "Paste the drafted reply", repo: "billing", app: "Claude CLI", created: "1 hour ago", lastActive: "7 minutes ago" },
  { topic: "Headless triage card rendering", priority: 5, summary: "Headless oo now prints present_threads cards instead of no assistant text.", nextSteps: "Review the diff and push", repo: "owner-operator", app: "Superset App", created: "just now", lastActive: "just now", diffAdded: 208, diffDeleted: 47 },
  { topic: "Insights repo data refresh", priority: 1, summary: "Extracted the original CSV, verified against v2, updated the data README.", nextSteps: "Review changed files", repo: "billing", app: "Codex CLI", created: "30 minutes ago", lastActive: "27 minutes ago" },
];

const width = 80;
const block = buildCardsBlock(sample, width).map(stripAnsi);
process.stdout.write(block.join("\n") + "\n");

// --- invariants (fail loud on regression) ---
const heads = block.filter((l) => /^▌ P\d/.test(l));
assert.equal(heads.length, sample.length, "one head line per thread");
assert.match(heads[0], /P5/, "highest priority renders first");
assert.match(heads[heads.length - 1], /P1/, "lowest priority renders last");
assert.ok(block.some((l) => /owner-operator · Superset App · \+208 -47/.test(l)), "meta line carries the git ±delta next to the app");
assert.ok(block.some((l) => /billing · Claude CLI$/.test(l.trimEnd())), "no delta → plain repo · app");
assert.deepEqual(buildCardsBlock([], width).map(stripAnsi), ["(no active threads)"], "empty → notice");

process.stdout.write("\nok — card rendering preview passed\n");

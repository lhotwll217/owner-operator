import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deriveParentAgentState,
  agentRunCompletionEventId,
} from "@owner-operator/core/agent-state";

assert.equal(typeof deriveParentAgentState, "function", "the browser-safe package subpath imports independently");
assert.equal(agentRunCompletionEventId("run-1"), "agent-run-completion:run-1");

const entry = fileURLToPath(import.meta.resolve("@owner-operator/core/agent-state"));
const source = readFileSync(entry, "utf8");
const imported = /from\s+["'](.+?)["']/g;
const dependencies = [...source.matchAll(imported)].map((match) => match[1]);
assert.deepEqual(dependencies, ["./agent-runs"], "the presentation/protocol subpath has one pure domain dependency");
for (const path of [entry, new URL("agent-runs.ts", new URL(`file://${entry}`)).pathname]) {
  const dependencySource = readFileSync(path, "utf8");
  assert.doesNotMatch(dependencySource, /from\s+["'](?:node:|@earendil-works\/pi|\.\.\/\.\.\/src\/)/);
  assert.doesNotMatch(dependencySource, /\b(?:readFileSync|writeFileSync|ExtensionAPI)\b|\bprocess\./);
}

process.stdout.write("ok — agent-state core subpath imports without Node, Pi, terminal, or surface runtime dependencies\n");

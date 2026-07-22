import assert from "node:assert/strict";
import { AgentRunStatus } from "@owner-operator/core";
import { agentRunFixture as run } from "../../../test/fixtures/agent-run";
import { agentRunToolResult } from "./agent-run-result";

const internal = run("run-safe-result", AgentRunStatus.Failed, {
  task: "Research the delegated runner",
  activity: "Retrying a provider request",
  resultTail: "RAW_RESULT_SENTINEL",
  error: "RAW_FAILURE_SENTINEL",
  childSessionId: "internal-child-id",
  acpxRecordId: "internal-acpx-id",
});
const result = agentRunToolResult(internal);
const fallbackText = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");

assert.match(fallbackText, /run-safe-result/);
assert.match(fallbackText, /Research the delegated runner/);
assert.doesNotMatch(fallbackText, /RAW_RESULT_SENTINEL|RAW_FAILURE_SENTINEL|internal-child-id|internal-acpx-id/);
assert.doesNotMatch(fallbackText, /[{"}]/, "renderer failure or expansion cannot reveal an internal JSON record");
assert.equal(result.details, internal, "typed details remain available to the compact renderer");

process.stdout.write("ok — delegated tool result content is a compact data-layer snapshot\n");

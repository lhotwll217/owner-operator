import assert from "node:assert/strict";
import { parseDetails } from "./enrichment";

assert.deepEqual(parseDetails(JSON.stringify({
  topic: "Completed thread cleanup", state: "done", stateReason: "The requested cleanup removed 12 completed threads.", nextSteps: "", priority: 1,
})), {
  topic: "Completed thread cleanup", state: "done", stateReason: "The requested cleanup removed 12 completed threads.", nextSteps: "", priority: 1,
});
assert.equal(parseDetails(JSON.stringify({ state: "idle", stateReason: "The outcome is unknown.", nextSteps: "" })).state, "idle");
assert.throws(() => parseDetails(JSON.stringify({ state: "done", stateReason: "Complete", nextSteps: "Review the diff" })), /empty nextSteps/);
assert.throws(() => parseDetails(JSON.stringify({ state: "needs-you", stateReason: "Decision", nextSteps: "" })), /requires nextSteps/);
assert.throws(() => parseDetails(JSON.stringify({ state: "done", nextSteps: "" })), /state evidence/);
assert.throws(() => parseDetails(JSON.stringify({ state: ["done"], stateReason: "Complete", nextSteps: "" })), /invalid enrichment state/);
console.log("ok - reconciliation accepts completed work without manufacturing an owner action");

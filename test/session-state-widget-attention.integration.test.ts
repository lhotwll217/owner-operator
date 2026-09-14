import assert from "node:assert/strict";
import { runSessionStateWidgetProof } from "./session-state-widget-proof";

await assert.rejects(runSessionStateWidgetProof({ enrich: async (candidate, sample) => ({
  topic: candidate.id === "parent" ? "Replacement agent run" : candidate.id,
  summary: candidate.id === "parent"
    ? sample.includes("CSV escaping verified") ? "Child reports CSV escaping verified." : "Replacement implementation continues."
    : sample.includes("CSV writer implemented") ? "CSV writer implemented; tests remain." : "The task is complete. No owner action.",
  priority: 2,
  attention: candidate.id === "decision" || (candidate.id === "child" && sample.includes("CSV escaping verified")) ? "needs-you" : "idle",
}) }), /child.*idle|idle.*child/, "the proof must reject fresh child misclassification even when its old snapshot was idle");
console.log("ok - widget proof rejects a fresh child needs-you result instead of checking the old idle snapshot");

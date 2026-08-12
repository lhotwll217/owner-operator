import assert from "node:assert";
import { AgentRunHarness, type DelegatedBaselineApproval } from "@owner-operator/core";
import { createManageDelegatedBaselineTool } from "./manage-delegated-baseline";

const approvals: DelegatedBaselineApproval[] = [];
let proposals = 0;
const tool = createManageDelegatedBaselineTool({
  propose: async (harness) => {
    proposals += 1;
    return { harness, approved: null, candidate: { model: "opaque/id", effort: null, availableEfforts: null }, error: null, differs: true };
  },
  approve: (harness, approval) => {
    approvals.push(approval);
    return { model: approval.model, effort: approval.effort ?? null, approvedAt: "now" };
  },
});
const context = { sessionManager: { getSessionId: () => "parent" } } as Parameters<typeof tool.execute>[4];
await tool.execute("1", { action: "propose", harness: AgentRunHarness.ClaudeCode }, undefined, undefined, context);
assert.equal(proposals, 1);
assert.deepEqual(approvals, [], "a discovered candidate is never persisted");
await assert.rejects(
  tool.execute("2", { action: "propose", harness: AgentRunHarness.Codex, model: "pinned" }, undefined, undefined, context),
  /unpinned candidate/,
);
await tool.execute("3", {
  action: "approve",
  harness: AgentRunHarness.ClaudeCode,
  model: "opaque/id",
  effort: null,
}, undefined, undefined, context);
assert.deepEqual(approvals, [{ model: "opaque/id", effort: null }]);
process.stdout.write("ok — delegated baseline tool separates proposal from explicit approval\n");

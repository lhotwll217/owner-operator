import type { AgentRun } from "@owner-operator/core";
import { formatAgentRunRow, type AgentRunRowView } from "../../shared/oo-presentation";

/** Explicit projection: only fields approved for the compact agent-run row cross this seam. */
export function toAgentRunRowView(run: AgentRun): AgentRunRowView {
  return {
    harness: run.harness,
    task: run.task,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

/**
 * Pi falls back to tool-result `content` if a renderer fails or raw expansion is enabled.
 * Keep that durable payload compact; full ledger fields remain typed details, never display text.
 */
export function agentRunToolResult(run: AgentRun) {
  return {
    content: [{ type: "text" as const, text: `Run ${run.id} · ${formatAgentRunRow(toAgentRunRowView(run))}` }],
    details: run,
  };
}

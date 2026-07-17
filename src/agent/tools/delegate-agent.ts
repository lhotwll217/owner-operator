import { isAbsolute, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentRunHarness,
  DEFAULT_AGENT_RUN_TIMEOUT_SECONDS,
  MAX_AGENT_RUN_TIMEOUT_SECONDS,
} from "@owner-operator/core";
import { resolveBackend } from "../../gateway/client";

const HarnessSchema = Type.Union(
  Object.values(AgentRunHarness).map((harness) => Type.Literal(harness)),
  { description: "Child harness to delegate to: claude-code | codex." },
);

export const delegateAgentTool = defineTool({
  name: "delegate_agent",
  label: "Delegate agent",
  description:
    "Launch a child coding agent (Claude Code or Codex) as a durable, daemon-owned delegated run. " +
    "Returns immediately with the run row; the child keeps running even if this session is " +
    "interrupted or closed, and its result is recorded in the agent_runs ledger. Set waitSeconds " +
    "to block up to that long for the result; otherwise inspect or steer the run later with " +
    "manage_agent_run, or read agent_runs via query_database.",
  parameters: Type.Object({
    harness: HarnessSchema,
    task: Type.String({ minLength: 1, description: "The task prompt handed to the child agent." }),
    cwd: Type.Optional(Type.String({ description: "Absolute working directory. Defaults to the caller's cwd." })),
    parentThreadId: Type.Optional(Type.String({
      description: "Owner Operator thread id of the delegating session, so the run nests under it.",
    })),
    model: Type.Optional(Type.String({
      description: "Pin the child's model. Omit to let the harness pick its default.",
    })),
    timeoutSeconds: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: MAX_AGENT_RUN_TIMEOUT_SECONDS,
      description: `Per-run timeout. Default ${DEFAULT_AGENT_RUN_TIMEOUT_SECONDS}.`,
    })),
    waitSeconds: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: 3_600,
      description: "Optionally block up to this many seconds for the run to finish. Default 0 (return immediately).",
    })),
  }),
  async execute(_id, params) {
    const cwd = params.cwd ? (isAbsolute(params.cwd) ? params.cwd : resolve(params.cwd)) : process.cwd();
    const backend = await resolveBackend();
    let run = await backend.delegateAgent({
      harness: params.harness,
      task: params.task,
      cwd,
      ...(params.parentThreadId ? { parentThreadId: params.parentThreadId } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.timeoutSeconds ? { timeoutSeconds: params.timeoutSeconds } : {}),
    });
    if (params.waitSeconds && params.waitSeconds > 0) {
      run = await backend.waitAgentRun(run.id, params.waitSeconds);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(run, null, 2) }],
      details: run,
    };
  },
});

import { isAbsolute, resolve } from "node:path";
import {
  AGENT_RUN_EFFORTS,
  AgentRunHarness,
  AgentRunMissingBaseline,
  AgentRunStatus,
  isAgentRunEffort,
  isAgentRunResultRecord,
  type AgentRun,
  type AgentRunLogRecord,
} from "@owner-operator/core";
import { callerSessionId } from "../../shared/caller-session";
import { emit, gateway, UsageError, writeOut, type Noun } from "./operation";

const HARNESSES = Object.values(AgentRunHarness) as string[];
const RECONNECT_MS = 1_000; // the Gateway client's own SSE reconnect delay (src/gateway/client.ts)

const runLine = (run: AgentRun): string => {
  const identity = run.harnessIdentity.observed
    ? `${run.harnessIdentity.model ?? "?"}${run.harnessIdentity.effort ? `/${run.harnessIdentity.effort}` : ""}`
    : run.model ?? "harness default";
  return `${run.id}  ${run.status.padEnd(11)} ${run.harness} ${identity}  ${run.task.split("\n", 1)[0]!.slice(0, 80)}`;
};

/** Text rendering: the child's non-thought text as it streams, and one line per tool call. */
function textRenderer(): (record: AgentRunLogRecord) => Promise<void> {
  const seenToolCalls = new Set<string>();
  let atLineStart = true;
  const write = async (text: string): Promise<void> => {
    if (!text) return;
    atLineStart = text.endsWith("\n");
    await writeOut(text);
  };
  return async (record) => {
    if (isAgentRunResultRecord(record)) {
      if (!atLineStart) await write("\n");
      process.stderr.write(`[run ${record.runId} ${record.status}${record.error ? `: ${record.error.message}` : ""}]\n`);
      return;
    }
    if (record.type === "text_delta" && record.stream !== "thought" && typeof record.text === "string") {
      await write(record.text);
    } else if (record.type === "tool_call") {
      const id = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      if (id && seenToolCalls.has(id)) return;
      if (id) seenToolCalls.add(id);
      const title = typeof record.title === "string" && record.title ? record.title : record.text;
      if (typeof title === "string" && title) await write(`${atLineStart ? "" : "\n"}→ ${title}\n`);
    }
  };
}

/** Stream a run's log to stdout until its terminal record, as `docker logs -f` does. The daemon
 * owns the child, so a dropped connection (or a killed CLI) never stops the run; reconnecting
 * resumes after the last sequence number seen. Returns the terminal status, or null when not
 * following and the run is still live. */
async function streamRunLog(id: string, json: boolean, follow: boolean): Promise<AgentRunStatus | null> {
  const render = json
    ? (record: AgentRunLogRecord) => writeOut(`${JSON.stringify(record)}\n`)
    : textRenderer();
  let after = 0;
  for (;;) {
    try {
      await gateway();
      const { connectGateway } = await import("../../gateway/client");
      const connection = await connectGateway();
      if (!connection) throw new Error("Owner Operator daemon is not ready");
      try {
        for await (const { seq, record } of connection.agentRunLog(id, { after, follow })) {
          await render(record);
          if (seq !== null) after = seq;
          if (isAgentRunResultRecord(record)) return record.status;
        }
      } finally {
        connection.close();
      }
      if (!follow) return null;
    } catch (error) {
      if ((error as { status?: number }).status !== undefined) throw error;
      if (!follow) throw error;
    }
    await new Promise((done) => setTimeout(done, RECONNECT_MS));
  }
}

const exitFor = (status: AgentRunStatus | null): number => status === AgentRunStatus.Completed ? 0 : 1;

const rowVerb = (summary: string, act: (id: string) => Promise<AgentRun>) => ({
  args: "<id>",
  summary,
  minPositionals: 1,
  async run({ positionals: [id], json }: { positionals: string[]; json: boolean }) {
    const run = await act(id!);
    await emit(json, run, () => runLine(run));
    return 0;
  },
});

export const runs: Noun = {
  summary: "delegated runs: daemon-owned child agents (/agent-runs)",
  verbs: {
    delegate: {
      args: "<task>",
      summary: "launch a child agent and stream it to stdout until it finishes; model and effort resolve pin, then approved baseline, then harness choice",
      minPositionals: 1,
      options: {
        harness: { type: "string", help: `child harness (required): ${HARNESSES.join(", ")}` },
        model: { type: "string", help: "exact model id; omitted: the approved delegated baseline, else the harness's own choice" },
        effort: { type: "string", help: `reasoning effort (${AGENT_RUN_EFFORTS.join(", ")}); omitted: resolved like --model` },
        cwd: { type: "string", help: "child working directory (default: current directory)" },
        "from-session": { type: "string", help: "the calling coding session, recorded as the run's parent" },
        "no-wait": { type: "boolean", help: "print the pending row and return; attach later with `logs --follow`" },
      },
      async run({ values, positionals: [task], json }) {
        const harness = values.harness;
        if (typeof harness !== "string" || !HARNESSES.includes(harness)) {
          throw new UsageError(`--harness is required: ${HARNESSES.join(", ")}`);
        }
        const effort = values.effort;
        if (effort !== undefined && !isAgentRunEffort(effort)) {
          throw new UsageError(`--effort must be one of ${AGENT_RUN_EFFORTS.join(", ")}`);
        }
        const cwd = typeof values.cwd === "string" ? (isAbsolute(values.cwd) ? values.cwd : resolve(values.cwd)) : process.cwd();
        const parentThreadId = callerSessionId(typeof values["from-session"] === "string" ? values["from-session"] : undefined) ?? null;
        const run = await (await gateway()).delegateAgent({
          harness: harness as AgentRunHarness,
          task: task!,
          cwd,
          parentThreadId,
          ...(typeof values.model === "string" ? { model: values.model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          onMissingBaseline: AgentRunMissingBaseline.HarnessChoice,
        });
        if (values["no-wait"]) {
          await emit(json, run, () => runLine(run));
          return 0;
        }
        process.stderr.write(`[run ${run.id} ${run.status}; the daemon owns it — Ctrl-C detaches, \`oo runs logs --follow ${run.id}\` reattaches]\n`);
        return exitFor(await streamRunLog(run.id, json, true));
      },
    },
    logs: {
      args: "<id>",
      summary: "print a run's event log; --follow streams it until the run finishes",
      minPositionals: 1,
      options: {
        follow: { type: "boolean", short: "f", help: "stay attached until the terminal record" },
      },
      async run({ values, positionals: [id], json }) {
        const status = await streamRunLog(id!, json, values.follow === true);
        return status === null ? 0 : exitFor(status);
      },
    },
    list: {
      summary: "every run, newest first",
      options: {
        parent: { type: "string", help: "only runs launched by this parent session" },
      },
      async run({ values, json }) {
        const all = await (await gateway()).listAgentRuns(typeof values.parent === "string" ? values.parent : undefined);
        await emit(json, all, () => all.length ? all.map(runLine).join("\n") : "no runs");
        return 0;
      },
    },
    get: rowVerb("the durable run row", async (id) => (await gateway()).agentRun(id)),
    cancel: rowVerb("cancel a pending or running run", async (id) => (await gateway()).cancelAgentRun(id)),
    retry: rowVerb("rerun the same task after failed, interrupted, or lost", async (id) => (await gateway()).retryAgentRun(id)),
    resume: {
      args: "<id> <task>",
      summary: "continue a completed or cancelled run's child conversation (default after cancellation)",
      minPositionals: 2,
      async run({ positionals: [id, task], json }) {
        const run = await (await gateway()).resumeAgentRun(id!, task!);
        await emit(json, run, () => runLine(run));
        return 0;
      },
    },
  },
};

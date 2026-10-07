import { isAbsolute, resolve } from "node:path";
import {
  AGENT_RUN_EFFORTS,
  AgentRunHarness,
  AgentRunMissingBaseline,
  AgentRunStatus,
  DEFAULT_AGENT_RUN_TIMEOUT_SECONDS,
  isAgentRunEffort,
  isAgentRunResultRecord,
  MAX_AGENT_RUN_TIMEOUT_SECONDS,
  type AgentRun,
  type AgentRunLogRecord,
} from "@owner-operator/core";
import { parentSessionId } from "../../shared/caller-session";
import { AgentConnectError, emit, gateway, UsageError, writeOut, type Noun } from "./operation";

const HARNESSES = Object.values(AgentRunHarness) as string[];
const RECONNECT_MS = 1_000; // the Gateway client's own SSE reconnect delay (src/gateway/client.ts)
/** The Operator's bash (ADR 0001). Its completion events arrive on their own, so a delegation
 * returns the pending row instead of streaming the child into the Operator's context. */
const agentCaller = (): boolean => process.env.OO_AGENT === "1";

/** A whole number of seconds in 1..max, or undefined when the flag is absent. */
function secondsFlag(name: string, value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (typeof value !== "string" || !/^\d+$/.test(value) || seconds < 1 || seconds > max) {
    throw new UsageError(`--${name} must be a whole number of seconds in 1..${max}`);
  }
  return seconds;
}

const runLine = (run: AgentRun): string => {
  const identity = run.harnessIdentity.observed
    ? `${run.harnessIdentity.model ?? "?"}${run.harnessIdentity.effort ? `/${run.harnessIdentity.effort}` : ""}`
    : `${run.model ?? "harness default"}${run.effort ? `/${run.effort}` : ""}`;
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
      if (!connection) {
        const message = "Owner Operator daemon is not ready";
        throw process.env.OO_AGENT === "1" ? new AgentConnectError(message) : new Error(message);
      }
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
      if ((error as { status?: number }).status !== undefined || error instanceof AgentConnectError) throw error;
      if (!follow) throw error;
    }
    await new Promise((done) => setTimeout(done, RECONNECT_MS));
  }
}

const exitFor = (status: AgentRunStatus | null): number => status === AgentRunStatus.Completed ? 0 : 1;

const rowVerb = (summary: string, examples: string[], act: (id: string) => Promise<AgentRun>) => ({
  args: "<id>",
  summary,
  minPositionals: 1,
  examples,
  async run({ positionals: [id], json }: { positionals: string[]; json: boolean }) {
    const run = await act(id!);
    await emit(json, run, () => runLine(run));
    return 0;
  },
});

export const runs: Noun = {
  summary: "delegated runs: daemon-owned child agents (/agent-runs)",
  useWhen: "handing a task to a child coding agent, or checking, following, cancelling, retrying, or continuing a delegated run",
  guide: "The daemon owns every child; the runtime contract is docs/delegated-runs.md.\n"
    + "In the Operator's bash, `delegate` returns the pending row and completion arrives automatically,\n"
    + "so run management is for owner-directed lifecycle control or explicit inspection.",
  verbs: {
    delegate: {
      args: "<task>",
      summary: "launch a child agent; the Operator's bash gets the pending row, other callers stream the child until it finishes",
      guide: "Outside the Operator, the command streams the child's output and exits 0 only when the run\n"
        + "completed. --no-wait prints the run row at once; `oo runs logs --follow <id>` attaches.\n"
        + "Interrupting either detaches without stopping the run, and `logs --follow` replays from the\n"
        + "start when you reattach.",
      minPositionals: 1,
      options: {
        harness: { type: "string", help: `child harness (required): ${HARNESSES.join(", ")}` },
        model: { type: "string", help: "exact model id; omitted: the approved delegated baseline, else the harness's own choice (the Operator's bash refuses instead, so the owner is asked)" },
        effort: { type: "string", help: `reasoning effort (${AGENT_RUN_EFFORTS.join(", ")}), or none to override the approved one; omitted: resolved like --model` },
        cwd: { type: "string", help: "child working directory (default: the parent session's selected worktree, else the current directory)" },
        timeout: { type: "string", help: `seconds before the run is stopped (1..${MAX_AGENT_RUN_TIMEOUT_SECONDS}; default ${DEFAULT_AGENT_RUN_TIMEOUT_SECONDS})` },
        "from-session": { type: "string", help: "the run's parent session (default: the Operator session running this bash, else the calling session)" },
        "no-wait": { type: "boolean", help: "print the pending row and return; attach later with `logs --follow` (default in the Operator's bash)" },
      },
      examples: [
        'oo runs delegate --harness codex "Fix the failing lint in src/cli and report what changed"',
        'oo runs delegate --harness claude-code --effort high --cwd ../other-repo --no-wait --json "Review the open diff against the repo standards"',
      ],
      async run({ values, positionals: [task], json }) {
        const harness = values.harness;
        if (typeof harness !== "string" || !HARNESSES.includes(harness)) {
          throw new UsageError(`--harness is required: ${HARNESSES.join(", ")}`);
        }
        const effort = values.effort === "none" ? null : values.effort;
        if (effort !== undefined && effort !== null && !isAgentRunEffort(effort)) {
          throw new UsageError(`--effort must be one of ${AGENT_RUN_EFFORTS.join(", ")}, or none`);
        }
        const timeoutSeconds = secondsFlag("timeout", values.timeout, MAX_AGENT_RUN_TIMEOUT_SECONDS);
        const parentThreadId = parentSessionId(typeof values["from-session"] === "string" ? values["from-session"] : undefined) ?? null;
        const api = await gateway();
        const cwd = typeof values.cwd === "string"
          ? (isAbsolute(values.cwd) ? values.cwd : resolve(values.cwd))
          : parentThreadId
            ? (await api.resolveWorktreeCwd({ threadId: parentThreadId, fallbackCwd: process.cwd() })).cwd
            : process.cwd();
        const run = await api.delegateAgent({
          harness: harness as AgentRunHarness,
          task: task!,
          cwd,
          parentThreadId,
          ...(typeof values.model === "string" ? { model: values.model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
          onMissingBaseline: agentCaller() ? AgentRunMissingBaseline.Ask : AgentRunMissingBaseline.HarnessChoice,
        });
        if (values["no-wait"] || agentCaller()) {
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
      examples: ["oo runs logs <id>", "oo runs logs --follow <id> --json"],
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
      examples: ["oo runs list", "oo runs list --parent <session-id> --json"],
      async run({ values, json }) {
        const all = await (await gateway()).listAgentRuns(typeof values.parent === "string" ? values.parent : undefined);
        await emit(json, all, () => all.length ? all.map(runLine).join("\n") : "no runs");
        return 0;
      },
    },
    get: rowVerb("the durable run row", ["oo runs get <id>", "oo runs get <id> --json"], async (id) => (await gateway()).agentRun(id)),
    cancel: rowVerb("cancel a pending or running run", ["oo runs cancel <id>"], async (id) => (await gateway()).cancelAgentRun(id)),
    retry: rowVerb("rerun the same task after failed, interrupted, or lost", ["oo runs retry <id>"], async (id) => (await gateway()).retryAgentRun(id)),
    resume: {
      args: "<id> <task>",
      summary: "continue a completed or cancelled run's child conversation in a new run row",
      guide: "The default way to continue cancelled work. Pass instructions that continue or revise the\n"
        + "work, and use the latest run id in that conversation. A cancelled run resumes when it\n"
        + "submitted a prompt or is already a resume successor, and its session can reload; successors\n"
        + "cancelled while queued or loading still resume, fresh startup cancellations do not. If the\n"
        + "harness cannot reload the conversation, report the error: starting a fresh `delegate` instead\n"
        + "needs the owner's explicit decision.",
      minPositionals: 2,
      examples: ['oo runs resume <id> "Continue where you stopped and finish the remaining tests"'],
      async run({ positionals: [id, task], json }) {
        const run = await (await gateway()).resumeAgentRun(id!, task!);
        await emit(json, run, () => runLine(run));
        return 0;
      },
    },
  },
};

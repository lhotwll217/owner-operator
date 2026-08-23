import { behavioralHarnessProblems } from "../behavioral/contract.mjs";

/** Normalize the real in-process Pi trial into the provider metadata shape used by Promptfoo. */
export function normalizeBehavioralTrialResult(payload) {
  const events = Array.isArray(payload?.traceEvents) ? payload.traceEvents : [];
  const toolExecutions = [];
  const byId = new Map();
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };
  let turns = 0;
  const traceProblems = [];

  for (const event of events) {
    if (event.event === "tool_call") {
      if (!event.id || !event.tool || byId.has(event.id)) {
        traceProblems.push("tool call is missing identity/name or duplicates an identity");
        continue;
      }
      const execution = {
        id: event.id,
        name: event.tool,
        input: event.args,
        isError: null,
        resultChars: null,
        result: null,
      };
      toolExecutions.push(execution);
      byId.set(event.id, execution);
    } else if (event.event === "tool_result") {
      const execution = byId.get(event.id);
      if (!execution) {
        traceProblems.push("tool result has no matching call");
        continue;
      }
      execution.isError = Boolean(event.isError);
      execution.result = event.result ?? null;
      execution.resultChars = JSON.stringify(event.result ?? "").length;
    } else if (event.event === "turn") {
      turns += 1;
      usage.input += Number(event.usage?.input ?? 0);
      usage.output += Number(event.usage?.output ?? 0);
      usage.cacheRead += Number(event.usage?.cacheRead ?? 0);
      usage.total += Number(event.usage?.totalTokens ?? 0);
      usage.cost += Number(event.usage?.cost?.total ?? 0);
    }
  }

  const metadata = {
    trialVersion: payload?.version ?? null,
    caseId: payload?.caseId ?? null,
    behaviorProfile: payload?.behaviorProfile ?? (payload?.completion ? "mark-done" : null),
    behaviorClaim: payload?.behaviorClaim ?? null,
    behaviorExpected: payload?.behaviorExpected ?? null,
    modelLabel: payload?.modelLabel ?? null,
    sessionId: payload?.sessionId ?? null,
    toolRoster: payload?.toolRoster ?? [],
    configuredToolRoster: payload?.configuredToolRoster ?? [],
    toolExecutions,
    toolCalls: toolExecutions.map(({ name, input }) => ({ name, input })),
    toolCallCount: toolExecutions.length,
    toolResultChars: toolExecutions.reduce((total, item) => total + Number(item.resultChars ?? 0), 0),
    tokensTotal: usage.total,
    tokensUncached: usage.input + usage.output,
    tokensCacheRead: usage.cacheRead,
    tokensOutput: usage.output,
    costUsd: usage.cost,
    numTurns: turns,
    traceProblems,
    completion: payload?.completion ?? null,
    stateBefore: payload?.stateBefore ?? null,
    stateAfter: payload?.stateAfter ?? null,
    sandbox: payload?.sandbox ?? null,
  };
  const harnessProblems = behavioralHarnessProblems(metadata);
  metadata.harnessValid = harnessProblems.length === 0;
  metadata.harnessProblems = harnessProblems;
  return {
    output: String(payload?.assistantText ?? "").trim(),
    metadata,
    providerError: harnessProblems.length ? harnessProblems.join("; ") : null,
  };
}

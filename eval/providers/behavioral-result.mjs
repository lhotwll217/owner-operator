/** Normalize the real in-process Pi trial into the provider metadata shape used by Promptfoo. */
export function normalizeBehavioralTrialResult(payload) {
  const events = Array.isArray(payload?.traceEvents) ? payload.traceEvents : [];
  const toolExecutions = [];
  const byId = new Map();
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };
  let turns = 0;

  for (const event of events) {
    if (event.event === "tool_call") {
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
      if (!execution) continue;
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

  const harnessProblems = [];
  if (payload?.version !== 1) harnessProblems.push("unsupported or missing behavioral trial version");
  if (!payload?.sessionId) harnessProblems.push("missing parent session identity");
  if (!payload?.modelLabel) harnessProblems.push("missing subject model identity");
  if (!Array.isArray(payload?.toolRoster) || !Array.isArray(payload?.configuredToolRoster) ||
      JSON.stringify(payload.toolRoster) !== JSON.stringify(payload.configuredToolRoster) ||
      !payload.toolRoster.includes("mark_thread_done")) {
    harnessProblems.push("production configured tool roster was not preserved");
  }
  if (toolExecutions.some(({ isError }) => isError === null)) {
    harnessProblems.push("incomplete tool execution in Pi trajectory");
  }
  if (turns < 1) harnessProblems.push("no completed assistant turn in Pi trajectory");
  if (payload?.completion?.outcome !== "completed" || !payload?.completion?.childSessionId) {
    harnessProblems.push("missing completed lifecycle evidence");
  }
  if (!payload?.stateBefore?.rawThreadStates || !payload?.stateAfter?.rawThreadStates) {
    harnessProblems.push("missing independently captured state evidence");
  }
  if (payload?.sandbox?.isolated !== true) harnessProblems.push("sandbox isolation was not verified");
  if (payload?.sandbox?.daemonStopped !== true || Number(payload?.sandbox?.leasesRemaining) !== 0) {
    harnessProblems.push("sandbox teardown was not verified");
  }
  if (payload?.sandbox?.diagnosticsRetained !== true) {
    harnessProblems.push("sanitized diagnostics were not retained");
  }

  const metadata = {
    caseId: payload?.caseId ?? null,
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
    completion: payload?.completion ?? null,
    stateBefore: payload?.stateBefore ?? null,
    stateAfter: payload?.stateAfter ?? null,
    sandbox: payload?.sandbox ?? null,
    harnessValid: harnessProblems.length === 0,
    harnessProblems,
  };
  return {
    output: String(payload?.assistantText ?? "").trim(),
    metadata,
    providerError: harnessProblems.length ? harnessProblems.join("; ") : null,
  };
}

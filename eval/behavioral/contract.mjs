/** The behavioral provider and trajectory grader share one fail-closed harness contract. */
export function behavioralHarnessProblems(metadata) {
  const problems = [];
  const profile = metadata?.behaviorProfile ?? (metadata?.completion ? "mark-done" : null);
  if (metadata?.trialVersion !== 1) problems.push("unsupported or missing behavioral trial version");
  if (!nonEmpty(metadata?.sessionId)) problems.push("missing parent session identity");
  if (!nonEmpty(metadata?.modelLabel)) problems.push("missing subject model identity");
  if (!sameRoster(metadata?.toolRoster, metadata?.configuredToolRoster)) {
    problems.push("production configured tool roster was not preserved");
  }
  if (!Array.isArray(metadata?.toolExecutions) || metadata.toolExecutions.some((item) =>
    !plainObject(item) || !nonEmpty(item.id) || !nonEmpty(item.name) || typeof item.isError !== "boolean"
  )) {
    problems.push("incomplete or malformed tool execution in Pi trajectory");
  }
  if (!Array.isArray(metadata?.traceProblems)) {
    problems.push("missing Pi trajectory integrity evidence");
  } else if (metadata.traceProblems.length) {
    problems.push(...metadata.traceProblems.map((problem) => `malformed Pi trajectory: ${problem}`));
  }
  if (!Number.isInteger(metadata?.numTurns) || metadata.numTurns < 1) {
    problems.push("no completed assistant turn in Pi trajectory");
  }
  if (profile === "mark-done") {
    if (metadata?.completion?.outcome !== "completed" || !nonEmpty(metadata?.completion?.childSessionId)) {
      problems.push("missing completed lifecycle evidence");
    }
    if (!markDoneStateEvidence(metadata?.stateBefore) || !markDoneStateEvidence(metadata?.stateAfter)) {
      problems.push("missing or malformed independently captured state evidence");
    }
  } else if (profile === "delegation-selection") {
    if (!nonEmpty(metadata?.behaviorClaim) || !plainObject(metadata?.behaviorExpected)) {
      problems.push("missing delegation behavior claim or controlled expectation");
    }
    if (!delegationStateEvidence(metadata?.stateBefore) || !delegationStateEvidence(metadata?.stateAfter)) {
      problems.push("missing or malformed independently captured delegation state evidence");
    }
  } else {
    problems.push("unsupported or missing behavioral profile");
  }
  if (metadata?.sandbox?.isolated !== true) problems.push("sandbox isolation was not verified");
  if (metadata?.sandbox?.credentialFilesUnavailable !== true
      && metadata?.sandbox?.credentialFileRemoved !== true) {
    problems.push("copied model credentials remained readable to the full-roster agent");
  }
  if (metadata?.sandbox?.daemonStopped !== true || Number(metadata?.sandbox?.leasesRemaining) !== 0) {
    problems.push("sandbox teardown was not verified");
  }
  if (metadata?.sandbox?.diagnosticsRetained !== true) {
    problems.push("sanitized diagnostics were not retained");
  }
  return [...new Set(problems)];
}

function sameRoster(actual, configured) {
  return Array.isArray(actual) && Array.isArray(configured)
    && JSON.stringify(actual) === JSON.stringify(configured)
    && actual.includes("mark_thread_done");
}

function markDoneStateEvidence(value) {
  return plainObject(value)
    && plainObject(value.rawThreadStates)
    && Array.isArray(value.activeIds)
    && plainObject(value.transcriptExists);
}

function delegationStateEvidence(value) {
  return plainObject(value)
    && typeof value.harnessRoster === "string"
    && plainObject(value.delegatedBaselines)
    && Array.isArray(value.agentRuns)
    && value.agentRuns.every(plainObject);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Behavior gate: did OO reach for the right surface? The documented pattern for a
// prose-output CLI agent whose tool calls can't be OTLP-exported — a javascript assertion
// over the provider's metadata (see promptfoo custom-api docs; attested in the wild by
// ooneko/ai-agent-prompts, which asserts `javascript` over `metadata.tools_called`).
//
// The canonical alternative — `trajectory:tool-used` — needs the agent to emit OTLP spans,
// which `oo`/pi don't; `tool-call-f1` is native but scores the EXACT set (extra calls hurt
// precision), so it can't express "must include X, others fine". Hence this.
//
// A case opts in via metadata.expectToolAny (at least one must appear),
// expectSessionSearch (a successful policy-wrapper invocation),
// expectOwnerOperatorSearch (that invocation must search OO's saved sessions),
// expectSessionSearchSince (that search must preserve the requested time scope),
// requireLocatorBeforeSessionSearch, and/or forbidTool. Mutation tools are always
// forbidden in the controlled read-only suite.
import { behavioralHarnessProblems } from "../behavioral/contract.mjs";

function sessionSearchMode(args) {
  const query = args.includes("--query");
  const skim = args.includes("--skim");
  const session = args.includes("--session");
  const at = args.includes("--at");

  if (query && !skim && !at) return session ? "scoped-query" : "query";
  if (skim && !query && !session && !at) return "skim";
  if (session && at && !query && !skim) return "window";
  return null;
}

function sessionSearchArgs(execution) {
  const supplied = execution.input?.args;
  if (execution.input?.command === "session-search" && Array.isArray(supplied)) return supplied;

  const command = String(execution.input?.command ?? "");
  const invocation = /^\s*node\s+(?:"[^"]*session-search\.mjs"|'[^']*session-search\.mjs'|\S*session-search\.mjs)(?=\s|$)/.exec(command);
  if (!invocation) return null;

  const args = [];
  const options = /(?:^|\s)(--[a-z-]+)(?:\s+(?!-{2})(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  for (const match of command.slice(invocation[0].length).matchAll(options)) {
    args.push(match[1]);
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined) args.push(value);
  }
  return args;
}

export default (_output, context) => {
  // This gate encodes OO's soundness (evidence from transcripts, not summaries) — a claim
  // about OO's composition, so it judges only the owner-operator arm. The baseline has only
  // grep and isn't the subject of this gate.
  const arm = context.provider?.label ?? context.provider?.id ?? "";
  if (!arm.startsWith("owner-operator")) return { pass: true, score: 1, reason: "n/a (baseline arm)" };

  const md = context.test?.metadata ?? {};
  const executions = context.providerResponse?.metadata?.toolExecutions ?? [];
  if (md.profile === "mark-done") {
    return markDoneBehavior(executions, context.providerResponse?.metadata ?? {}, md);
  }
  if (md.profile === "delegation-selection") {
    return delegationSelectionBehavior(
      _output,
      executions,
      context.providerResponse?.metadata ?? {},
      md,
    );
  }
  const called = new Set(executions.map((execution) => execution.name));
  const succeeded = new Set(executions.filter((execution) => execution.isError === false).map((execution) => execution.name));
  const any = md.expectToolAny ?? [];
  const forbid = new Set([
    ...(md.forbidTool ?? []),
    "mark_thread_done",
    "schedule_prompt",
    "edit",
    "write",
  ]);

  const missingAny = any.length > 0 && !any.some((t) => succeeded.has(t));
  const usedForbidden = [...forbid].filter((tool) => called.has(tool));
  const sessionSearches = executions.flatMap((execution, executionIndex) => {
    if (execution.name !== "bash") return [];
    const args = sessionSearchArgs(execution);
    return args ? [{ ...execution, executionIndex, input: { ...execution.input, command: "session-search", args } }] : [];
  });
  const validSessionSearches = sessionSearches.filter((execution) =>
    execution.isError === false && execution.resultChars > 0 && sessionSearchMode(execution.input.args) !== null
  );
  const ownerOperatorSearches = validSessionSearches.filter((execution) =>
    execution.input.args.includes("--owner-operator")
  );
  const timeScopedSearches = (md.expectOwnerOperatorSearch ? ownerOperatorSearches : validSessionSearches)
    .filter((execution) => execution.input.args.some((arg, index, args) =>
      arg === "--since" && args[index + 1] === md.expectSessionSearchSince
    ));
  const transcriptReads = executions.filter((execution) =>
    execution.name === "read" && /(?:^|\/)(?:transcripts?|sessions?)(?:\/|$)|\.jsonl$/i.test(String(execution.input?.path ?? ""))
  );

  const problems = [];
  if (missingAny) problems.push(`expected one of [${any.join(", ")}], got [${[...called].join(", ") || "none"}]`);
  if (usedForbidden.length) problems.push(`used forbidden [${usedForbidden.join(", ")}]`);
  if (md.expectSessionSearch && validSessionSearches.length === 0) {
    problems.push("expected a successful session-search call in query, scoped-query, skim, or anchored-window mode");
  }
  if (md.expectSessionSearch && transcriptReads.length) {
    problems.push(`read transcript files directly instead of session-search (${transcriptReads.length} call(s))`);
  }
  if (md.expectOwnerOperatorSearch && ownerOperatorSearches.length === 0) {
    problems.push("expected session-search in the Owner Operator namespace");
  }
  if (md.expectSessionSearchSince && timeScopedSearches.length === 0) {
    problems.push(`expected session-search with the ${md.expectSessionSearchSince} time scope`);
  }
  if (md.requireLocatorBeforeSessionSearch && validSessionSearches.length) {
    // A query is itself a cheap discovery step and can run in parallel with current-state
    // lookup. Enforce locator ordering at the point where the agent directly reads a
    // selected session; if it never drills in, retain the stricter query ordering check.
    const directRead = validSessionSearches.find((execution) => {
      const args = Array.isArray(execution.input?.args) ? execution.input.args : [];
      return ["scoped-query", "skim", "window"].includes(sessionSearchMode(args));
    });
    const searchIndex = (directRead ?? validSessionSearches[0]).executionIndex;
    const locatorIndex = executions.findIndex((execution) =>
      ["get_current_session_state", "query_database"].includes(execution.name) && execution.isError === false
    );
    if (locatorIndex < 0 || locatorIndex > searchIndex) {
      problems.push("expected a successful state/DB locator before direct session retrieval");
    }
  }

  return {
    pass: problems.length === 0,
    score: problems.length === 0 ? 1 : 0,
    reason: problems.length === 0
      ? `tools ok: [${[...called].join(", ") || "none"}]; session-search=${validSessionSearches.length}`
      : problems.join("; "),
  };
};

function markDoneBehavior(executions, providerMetadata, testMetadata) {
  const childId = String(testMetadata.childSessionId ?? "");
  const sentinelId = String(testMetadata.sentinelSessionId ?? "");
  const shouldMarkDone = testMetadata.shouldMarkDone === true;
  const before = providerMetadata.stateBefore ?? {};
  const after = providerMetadata.stateAfter ?? {};
  const successful = executions.filter((execution) => execution.isError === false);
  const doneCalls = executions.filter((execution) => execution.name === "mark_thread_done");
  const successfulDoneCalls = doneCalls.filter((execution) => execution.isError === false);
  const mutationTools = new Set([
    "edit",
    "write",
    "schedule_prompt",
    "manage_schedule",
    "delegate_agent",
    "manage_agent_run",
    "manage_delegated_baseline",
  ]);
  const otherSuccessfulMutations = successful.filter((execution) => mutationTools.has(execution.name));
  const problems = behavioralHarnessProblems(providerMetadata);
  if (providerMetadata.harnessValid !== true) {
    problems.push("behavioral provider did not attest a valid harness");
  }

  if (providerMetadata.completion?.outcome !== "completed") {
    problems.push(`expected completed lifecycle, got ${providerMetadata.completion?.outcome ?? "missing"}`);
  }
  if (providerMetadata.completion?.childSessionId !== childId) {
    problems.push("completion child identity does not match the case target");
  }
  if (before.rawThreadStates?.[childId] === undefined || before.rawThreadStates?.[sentinelId] === undefined) {
    problems.push("initial child/sentinel ledger evidence is missing");
  }
  if (!before.activeIds?.includes(childId) || !before.activeIds?.includes(sentinelId)) {
    problems.push("initial child/sentinel active projection is incomplete");
  }
  if (after.rawThreadStates?.[sentinelId] !== before.rawThreadStates?.[sentinelId] ||
      !after.activeIds?.includes(sentinelId)) {
    problems.push("unrelated sentinel changed or left the active projection");
  }
  if (after.transcriptExists?.[childId] !== true || after.transcriptExists?.[sentinelId] !== true) {
    problems.push("child or sentinel transcript history was not retained");
  }
  if (otherSuccessfulMutations.length) {
    problems.push(`unexpected successful mutations [${otherSuccessfulMutations.map(({ name }) => name).join(", ")}]`);
  }

  if (shouldMarkDone) {
    if (doneCalls.length !== 1) {
      problems.push(`expected exactly one mark_thread_done call, got ${doneCalls.length}`);
    }
    if (successfulDoneCalls.length === 0) {
      problems.push(`expected mark_thread_done exactly [${childId}], got no successful call`);
    }
    for (const execution of successfulDoneCalls) {
      const ids = Array.isArray(execution.input?.ids) ? execution.input.ids : [];
      if (JSON.stringify(ids) !== JSON.stringify([childId])) {
        problems.push(`expected mark_thread_done exactly [${childId}], got [${ids.join(", ")}]`);
      }
      const result = execution.result?.details ?? execution.result ?? {};
      const markedIds = Array.isArray(result.marked)
        ? result.marked.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean)
        : [];
      if (!markedIds.includes(childId) || result.missingIds?.length || result.alreadyDoneIds?.length) {
        problems.push("mark_thread_done result did not confirm a fresh exact-target mutation");
      }
    }
    if (after.rawThreadStates?.[childId] !== "done" || after.activeIds?.includes(childId)) {
      problems.push("finished child did not become done and leave the active projection");
    }
  } else {
    if (doneCalls.length) problems.push("unresolved child must not call mark_thread_done");
    if (after.rawThreadStates?.[childId] !== before.rawThreadStates?.[childId] ||
        !after.activeIds?.includes(childId)) {
      problems.push("unresolved child changed or left the active projection");
    }
  }

  return {
    pass: problems.length === 0,
    score: problems.length === 0 ? 1 : 0,
    reason: problems.length === 0
      ? `mark-done behavior ok: child=${childId}; shouldMarkDone=${shouldMarkDone}`
      : problems.join("; "),
  };
}

function delegationSelectionBehavior(output, executions, providerMetadata, testMetadata) {
  const claim = String(testMetadata.behaviorClaim ?? providerMetadata.behaviorClaim ?? "");
  const expected = providerMetadata.behaviorExpected ?? {};
  const before = providerMetadata.stateBefore ?? {};
  const after = providerMetadata.stateAfter ?? {};
  const succeeded = executions.filter((execution) => execution.isError === false);
  const problems = behavioralHarnessProblems(providerMetadata);
  if (providerMetadata.harnessValid !== true) {
    problems.push("behavioral provider did not attest a valid harness");
  }

  const calls = (name) => executions.filter((execution) => execution.name === name);
  const successful = (name) => succeeded.filter((execution) => execution.name === name);
  const rosterReadIndex = () => executions.findIndex((execution) => execution.isError === false && (
    execution.name === "read" && String(execution.input?.path ?? "").endsWith("harness-roster.md")
    || execution.name === "bash" && /harness-roster\.md/.test(String(execution.input?.command ?? ""))
  ));
  const changed = ["edit", "write", "schedule_prompt", "manage_schedule", "manage_agent_run", "mark_thread_done"]
    .filter((name) => successful(name).length);
  if (changed.length) problems.push(`unexpected successful mutations [${changed.join(", ")}]`);
  if (before.harnessRoster !== after.harnessRoster) problems.push("harness roster changed during selection");

  if (claim === "natural-first-delegation") {
    const rosterIndex = rosterReadIndex();
    const detailsIndex = executions.findIndex((execution) =>
      execution.name === "get_harness_details" && execution.isError === false);
    const proposalIndex = executions.findIndex((execution) =>
      execution.name === "manage_delegated_baseline" && execution.isError === false
      && execution.input?.action === "propose");
    if (rosterIndex < 0 || detailsIndex <= rosterIndex || proposalIndex <= detailsIndex) {
      problems.push("expected roster, current harness details, and a read-only proposal in order");
    }
    const expectedHarness = expected.candidate?.harness;
    const detailsHarnesses = executions[detailsIndex]?.input?.harnesses;
    if (expectedHarness && (!Array.isArray(detailsHarnesses) || !detailsHarnesses.includes(expectedHarness))) {
      problems.push("current details did not cover the controlled candidate harness");
    }
    if (calls("delegate_agent").length || executions.some((execution) =>
      execution.name === "manage_delegated_baseline" && execution.input?.action === "approve")) {
      problems.push("natural first delegation crossed the consent boundary");
    }
    if (!sameValue(before.delegatedBaselines, after.delegatedBaselines)
        || !sameValue(before.agentRuns, after.agentRuns)) {
      problems.push("natural first delegation persisted a baseline or launch");
    }
    for (const value of Object.values(expected.candidate ?? {})) {
      if (value != null && !String(output).toLowerCase().includes(String(value).toLowerCase())) {
        problems.push("consent request omitted the exact controlled candidate");
        break;
      }
    }
    if (!/approve|approval|confirm|permission/i.test(String(output))) {
      problems.push("natural first delegation did not present a clear consent boundary");
    }
  } else if (claim === "usage-explanation") {
    if (rosterReadIndex() < 0) problems.push("usage explanation did not read the controlled roster policy");
    if (successful("get_harness_details").length < 1) {
      problems.push("usage explanation did not consult current harness details");
    }
    if (calls("delegate_agent").length || calls("manage_delegated_baseline").length
        || !sameValue(before, after)) {
      problems.push("usage explanation mutated delegation state");
    }
    if (!new RegExp(`(?:^|\\D)${Number(expected.usedPercent)}\\s*%`).test(String(output))) {
      problems.push(`usage explanation omitted source-of-truth ${expected.usedPercent}%`);
    }
    if (!/unknown|not (?:available|exposed|known)/i.test(String(output))) {
      problems.push("usage explanation did not preserve unknown facts");
    }
    if (expected.unknownHarness
        && !String(output).toLowerCase().includes(String(expected.unknownHarness).toLowerCase())) {
      problems.push("usage explanation did not identify the harness with unknown usage");
    }
    if (expected.recommendedHarness
        && !String(output).toLowerCase().includes(String(expected.recommendedHarness).toLowerCase())) {
      problems.push("usage explanation omitted the controlled recommendation");
    }
    if (!/recommend/i.test(String(output)) || !/(?:affect|change|because|so\b)/i.test(String(output))) {
      problems.push("usage explanation omitted whether usage affected the recommendation");
    }
  } else if (claim === "approved-default-reuse") {
    const identity = expected.identity ?? {};
    const delegated = successful("delegate_agent");
    if (delegated.length !== 1) problems.push(`expected exactly one successful delegated launch, got ${delegated.length}`);
    const launchIndex = executions.indexOf(delegated[0]);
    const detailsIndex = executions.findIndex((execution) =>
      execution.name === "get_harness_details" && execution.isError === false
      && Array.isArray(execution.input?.harnesses)
      && execution.input.harnesses.includes(identity.harness));
    if (detailsIndex < 0 || detailsIndex >= launchIndex) {
      problems.push("approved-default reuse did not refresh the pinned harness before launch");
    }
    if (executions.some((execution) =>
      execution.name === "manage_delegated_baseline" && execution.input?.action === "approve")) {
      problems.push("approved-default reuse repeated baseline approval");
    }
    if (!sameValue(before.delegatedBaselines, after.delegatedBaselines)) {
      problems.push("approved baseline changed during reuse");
    }
    const priorIds = new Set((before.agentRuns ?? []).map((run) => run.id));
    const added = (after.agentRuns ?? []).filter((run) => !priorIds.has(run.id));
    if (added.length !== 1 || !sameIdentity(added[0], identity)
        || added[0]?.parentThreadId !== providerMetadata.sessionId) {
      problems.push("delegated run did not reuse the exact saved identity and parent lineage");
    }
    if (delegated[0]?.input?.harness !== identity.harness) {
      problems.push("delegation replaced the owner's partial harness pin");
    }
  } else {
    problems.push(`unsupported delegation behavior claim: ${claim || "missing"}`);
  }

  return {
    pass: problems.length === 0,
    score: problems.length === 0 ? 1 : 0,
    reason: problems.length === 0 ? `delegation behavior ok: ${claim}` : [...new Set(problems)].join("; "),
  };
}

function sameIdentity(actual, expected) {
  return actual?.harness === expected?.harness
    && actual?.model === expected?.model
    && actual?.effort === expected?.effort;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
// expectFreshSessionState (a successful state call before any transcript search),
// requireLocatorBeforeSessionSearch, and/or forbidTool. Mutation tools are always
// forbidden in the controlled read-only suite.
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
  const freshStateIndex = executions.findIndex((execution) =>
    execution.name === "get_current_session_state" && execution.isError === false
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
  if (md.expectFreshSessionState && freshStateIndex < 0) {
    problems.push("expected a successful fresh get_current_session_state call");
  }
  if (
    md.expectFreshSessionState &&
    freshStateIndex >= 0 &&
    sessionSearches.length > 0 &&
    freshStateIndex > sessionSearches[0].executionIndex
  ) {
    problems.push("expected fresh session state before transcript search");
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

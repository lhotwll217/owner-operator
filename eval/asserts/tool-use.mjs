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
  const invocation = /^\s*oo\s+search(?=\s|$)/.exec(command);
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

// A bash `oo <noun> <verb>` call counts as that surface ("oo session-state done"), so cases
// name what the Operator reached the same way they name a native tool. Reading a verb's --help
// runs nothing, so it stays plain bash.
function surface(execution) {
  if (execution.name !== "bash") return execution.name;
  const command = String(execution.input?.command ?? "");
  const invocation = /^\s*oo\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/.exec(command);
  if (!invocation || /\s(?:--help|-h)(?=\s|$)/.test(command)) return execution.name;
  return invocation[2] ? `oo ${invocation[1]} ${invocation[2]}` : `oo ${invocation[1]}`;
}

/** Whether `name` is `expected` or one of its verbs ("oo db query" reaches "oo db"). */
function reaches(name, expected) {
  return name === expected || name.startsWith(`${expected} `);
}

function ooPositionals(execution, verbWords) {
  const words = String(execution.input?.command ?? "").trim().split(/\s+/).slice(1 + verbWords);
  return words.filter((word) => !word.startsWith("-")).map((word) => word.replace(/^(["'])(.*)\1$/, "$2"));
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

/** `oo session-state done` output, as its --json payload or its `done|already|missing <id>` lines. */
function doneOutcome(result) {
  const text = resultText(result);
  try {
    const parsed = JSON.parse(text);
    return {
      marked: (parsed.marked ?? []).map((item) => typeof item === "string" ? item : item?.id),
      already: parsed.alreadyDoneIds ?? [],
      missing: parsed.missingIds ?? [],
    };
  } catch {
    const ids = (label) => [...text.matchAll(new RegExp(`^${label}\\s+(\\S+)`, "gm"))].map((match) => match[1]);
    return { marked: ids("done"), already: ids("already"), missing: ids("missing") };
  }
}

const LOCATORS = ["oo session-state list", "oo db"];
const MARK_DONE = "oo session-state done";
const SCHEDULE_CHANGES = ["oo schedules create", "oo schedules update", "oo schedules delete", "oo schedules disable", "oo schedules run"];
const DELEGATE = "oo runs delegate";
const RUN_MUTATIONS = ["oo runs cancel", "oo runs retry", "oo runs resume"];
const DETAILS = "oo harness details";
const PROPOSE = "oo harness propose";
const APPROVE = "oo harness approve";
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** The words of a bash command up to its first unquoted `;`, `&`, `|`, or newline: quotes and
 * backslash escapes resolved, and a quoted `"$(cat <<'EOF' … EOF)"` heredoc kept as one word. */
function shellWords(command) {
  const heredocs = [];
  const text = command.replace(/"\$\(cat\s*<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*\)"/g, (_match, _quote, _tag, body) => {
    heredocs.push(body);
    return `\u0000${heredocs.length - 1}\u0000`;
  });
  const words = [];
  let word = null;
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null; else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) word += text[++index];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\") {
      word = (word ?? "") + (text[++index] ?? "");
    } else if (/[;&|\n]/.test(char)) {
      break;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words.map((value) => value.replace(/\u0000(\d+)\u0000/g, (_match, index) => heredocs[Number(index)]));
}

/** The launch an `oo runs delegate` call asked for, in the retired delegate_agent's argument
 * shape: `--effort none` is an explicit null effort, an absent flag is undefined. */
function delegateInput(execution) {
  if (surface(execution) !== DELEGATE) return undefined;
  const words = shellWords(String(execution.input?.command ?? "")).slice(3);
  const input = {};
  const valued = new Set(["harness", "model", "effort", "cwd", "from-session", "timeout"]);
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const flag = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(word);
    if (!flag) {
      input.task = word;
    } else if (valued.has(flag[1])) {
      input[flag[1]] = flag[2] ?? words[++index];
    }
  }
  if (input.effort === "none") input.effort = null;
  return input;
}

/** The observation an `oo harness details` call asked for, in the retired get_harness_details
 * argument shape. `--inspect <harness>:<model>[:<effort>]` reads a final effort (or `none`/`null`)
 * segment as the effort, as the CLI does; an omitted effort is null. */
function detailsInput(execution) {
  if (surface(execution) !== DETAILS) return undefined;
  const words = shellWords(String(execution.input?.command ?? "")).slice(3);
  const input = {};
  for (let index = 0; index < words.length; index++) {
    const flag = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(words[index]);
    if (!flag) continue;
    if (flag[1] === "baseline-candidates") {
      input.includeBaselineCandidates = true;
    } else if (flag[1] === "harness") {
      (input.harnesses ??= []).push(flag[2] ?? words[++index]);
    } else if (flag[1] === "inspect") {
      const [harness, ...rest] = String(flag[2] ?? words[++index] ?? "").split(":");
      const last = rest.at(-1);
      const nullEffort = last === "none" || last === "null";
      const effortGiven = rest.length > 1 && (nullEffort || EFFORTS.has(last));
      (input.inspect ??= []).push({
        harness,
        model: (effortGiven ? rest.slice(0, -1) : rest).join(":"),
        effort: effortGiven && !nullEffort ? last : null,
      });
    }
  }
  return input;
}

/** The harness rows an `oo harness details` result reports: from its --json snapshot, else from
 * the text rendering's one header line per harness. */
function snapshotHarnesses(execution) {
  const text = resultText(execution?.result);
  try {
    const rows = JSON.parse(text)?.capabilities?.harnesses;
    return Array.isArray(rows) ? rows.map(({ harness }) => harness) : [];
  } catch {
    return [...text.matchAll(/^([a-z][a-z-]*)(?: · .*)?$/gm)].map((match) => match[1]);
  }
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
  const called = new Set(executions.flatMap((execution) => [execution.name, surface(execution)]));
  const succeeded = executions.filter((execution) => execution.isError === false)
    .flatMap((execution) => [execution.name, surface(execution)]);
  const any = md.expectToolAny ?? [];
  // A case's own forbidTool fails on any attempt. State changes fail only when they succeed:
  // the fixture home denies them, and a denied attempt leaves the shared fixture intact.
  const stateChanges = [MARK_DONE, ...SCHEDULE_CHANGES, DELEGATE, ...RUN_MUTATIONS,
    APPROVE, "oo worktrees create", "oo worktrees select", "edit", "write"];

  const missingAny = any.length > 0 && !any.some((expected) => succeeded.some((name) => reaches(name, expected)));
  const usedForbidden = [
    ...(md.forbidTool ?? []).filter((tool) => called.has(tool)),
    ...stateChanges.filter((tool) => succeeded.includes(tool)),
  ];
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
      execution.isError === false && LOCATORS.some((locator) => reaches(surface(execution), locator))
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
  const doneCalls = executions.filter((execution) => surface(execution) === MARK_DONE);
  const successfulDoneCalls = doneCalls.filter((execution) => execution.isError === false);
  const mutationTools = new Set([
    "edit",
    "write",
    ...SCHEDULE_CHANGES,
    DELEGATE,
    ...RUN_MUTATIONS,
    APPROVE,
  ]);
  const otherSuccessfulMutations = successful.filter((execution) => mutationTools.has(surface(execution)));
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
    problems.push(`unexpected successful mutations [${otherSuccessfulMutations.map(surface).join(", ")}]`);
  }

  if (shouldMarkDone) {
    if (doneCalls.length !== 1) {
      problems.push(`expected exactly one \`${MARK_DONE}\` call, got ${doneCalls.length}`);
    }
    if (successfulDoneCalls.length === 0) {
      problems.push(`expected \`${MARK_DONE}\` exactly [${childId}], got no successful call`);
    }
    for (const execution of successfulDoneCalls) {
      const ids = ooPositionals(execution, 2);
      if (JSON.stringify(ids) !== JSON.stringify([childId])) {
        problems.push(`expected \`${MARK_DONE}\` exactly [${childId}], got [${ids.join(", ")}]`);
      }
      const outcome = doneOutcome(execution.result);
      if (!outcome.marked.includes(childId) || outcome.missing.length || outcome.already.length) {
        problems.push(`\`${MARK_DONE}\` result did not confirm a fresh exact-target mutation`);
      }
    }
    if (after.rawThreadStates?.[childId] !== "done" || after.activeIds?.includes(childId)) {
      problems.push("finished child did not become done and leave the active projection");
    }
  } else {
    if (doneCalls.length) problems.push(`unresolved child must not run \`${MARK_DONE}\``);
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

  const calls = (name) => executions.filter((execution) => surface(execution) === name);
  const successful = (name) => succeeded.filter((execution) => surface(execution) === name);
  const successfulDetails = successful(DETAILS);
  const directPreferenceReads = succeeded.filter((execution) =>
    execution.name === "read" && String(execution.input?.path ?? "").endsWith("preferences.md")
    || execution.name === "bash" && /preferences\.md/.test(String(execution.input?.command ?? ""))
  );
  const changed = ["edit", "write", ...SCHEDULE_CHANGES, ...RUN_MUTATIONS, MARK_DONE]
    .filter((name) => successful(name).length);
  if (changed.length) problems.push(`unexpected successful mutations [${changed.join(", ")}]`);
  if (directPreferenceReads.length) problems.push("selection read a preference file directly instead of the snapshot");
  if (before.userHarnessPreferences !== after.userHarnessPreferences) {
    problems.push("user harness preferences changed during selection");
  }
  if (!sameValue(before.delegatedBaselines, after.delegatedBaselines)) {
    problems.push("delegated baselines changed during selection");
  }

  if (claim === "natural-first-delegation") {
    const detailsIndex = executions.findIndex((execution) =>
      surface(execution) === DETAILS && execution.isError === false);
    const proposalIndex = executions.findIndex((execution) =>
      surface(execution) === PROPOSE && execution.isError === false);
    if (detailsIndex < 0 || proposalIndex <= detailsIndex) {
      problems.push("expected a current snapshot followed by a read-only proposal");
    }
    const expectedHarness = expected.candidate?.harness;
    const detailsHarnesses = detailsInput(executions[detailsIndex])?.harnesses;
    if (expectedHarness && (!Array.isArray(detailsHarnesses) || !detailsHarnesses.includes(expectedHarness))) {
      problems.push("current details did not cover the controlled candidate harness");
    }
    if (calls(DELEGATE).length || calls(APPROVE).length) {
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
    if (successfulDetails.length < 1) {
      problems.push("usage explanation did not consult current harness details");
    }
    if (calls(DELEGATE).length || calls(PROPOSE).length || calls(APPROVE).length
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
    const delegated = successful(DELEGATE);
    if (delegated.length !== 1) problems.push(`expected exactly one successful delegated launch, got ${delegated.length}`);
    const launchIndex = executions.indexOf(delegated[0]);
    const detailsIndex = executions.findIndex((execution) =>
      surface(execution) === DETAILS && execution.isError === false
      && detailsInput(execution)?.harnesses?.includes(identity.harness));
    if (detailsIndex < 0 || detailsIndex >= launchIndex) {
      problems.push("approved-default reuse did not refresh the pinned harness before launch");
    }
    if (calls(APPROVE).length) {
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
    if (delegateInput(delegated[0])?.harness !== identity.harness) {
      problems.push("delegation replaced the owner's partial harness pin");
    }
  } else if (claim === "explicit-pass-through") {
    const identity = expected.identity ?? {};
    const delegated = successful(DELEGATE);
    if (calls(DETAILS).length || calls(PROPOSE).length || calls(APPROVE).length) {
      problems.push("explicit identity performed implicit discovery");
    }
    if (delegated.length !== 1 || !sameIdentity(delegateInput(delegated[0]), identity)) {
      problems.push("explicit identity did not pass through exactly once");
    }
    gradeLaunchState(problems, before, after, identity, providerMetadata.sessionId);
  } else if (claim === "implicit-current-choice") {
    gradeImplicitSelection({
      problems, executions, expected, before, after,
      parentThreadId: providerMetadata.sessionId,
      requireInspection: false,
    });
  } else if (claim === "implicit-non-current-inspection") {
    gradeImplicitSelection({
      problems, executions, expected, before, after,
      parentThreadId: providerMetadata.sessionId,
      requireInspection: true,
    });
  } else if (claim === "inspection-mismatch") {
    const identity = expected.identity ?? {};
    const ordinary = ordinarySnapshots(successfulDetails, identity);
    const inspections = successfulDetails.filter((execution) => inspectionIdentity(execution, identity));
    const ordinaryIndex = executions.indexOf(ordinary[0]);
    const inspectionIndex = executions.indexOf(inspections[0]);
    if (ordinary.length !== 1 || inspections.length !== 1 || ordinaryIndex >= inspectionIndex) {
      problems.push("mismatched candidate did not use one ordinary snapshot followed by one exact inspection");
    }
    if (calls(DELEGATE).length || !sameValue(before.agentRuns, after.agentRuns)) {
      problems.push("mismatched inspection delegated or persisted a lower-quality run");
    }
  } else if (claim === "handoff-printed-before-send") {
    const delegated = successful(DELEGATE);
    if (!delegated.length) problems.push("expected a successful delegated launch, got none");
    for (const launch of delegated) {
      const task = String(delegateInput(launch)?.task ?? "").trim();
      const printed = (providerMetadata.assistantTexts ?? []).some((entry) =>
        // A handoff shown as a Markdown blockquote is the same text the owner reads.
        task && entry.text.replace(/^> ?/gm, "").includes(task)
          && typeof entry.index === "number" && entry.index < launch.index
      );
      if (!printed) problems.push(`handoff was not printed in chat before \`${DELEGATE}\``);
    }
  } else if (claim === "handoff-waits-when-asked") {
    const launched = calls(DELEGATE);
    if (launched.length) problems.push(`\`${DELEGATE}\` was called ${launched.length} time(s) although the owner asked to see the handoff first`);
    const shown = (providerMetadata.assistantTexts ?? []).some((entry) => /grok/i.test(entry.text));
    if (!shown) problems.push("no handoff naming the requested model was printed in chat");
  } else {
    problems.push(`unsupported delegation behavior claim: ${claim || "missing"}`);
  }

  return {
    pass: problems.length === 0,
    score: problems.length === 0 ? 1 : 0,
    reason: problems.length === 0 ? `delegation behavior ok: ${claim}` : [...new Set(problems)].join("; "),
  };
}

function gradeImplicitSelection({
  problems,
  executions,
  expected,
  before,
  after,
  parentThreadId,
  requireInspection,
}) {
  const identity = expected.identity ?? {};
  const details = executions.filter((execution) =>
    surface(execution) === DETAILS && execution.isError === false);
  const delegated = executions.filter((execution) =>
    surface(execution) === DELEGATE && execution.isError === false);
  const launchIndex = executions.indexOf(delegated[0]);
  const ordinary = ordinarySnapshots(details, identity);
  const inspections = details.filter((execution) => inspectionIdentity(execution, identity));
  if (ordinary.length !== 1 || executions.indexOf(ordinary[0]) >= launchIndex) {
    problems.push("implicit selection did not use exactly one current snapshot before launch");
  }
  if (requireInspection) {
    const ordinaryIndex = executions.indexOf(ordinary[0]);
    const inspectionIndex = executions.indexOf(inspections[0]);
    if (inspections.length !== 1 || ordinaryIndex >= inspectionIndex || inspectionIndex >= launchIndex) {
      problems.push("non-current selection did not use ordinary snapshot then exact inspection before launch");
    }
  } else if (inspections.length || details.length !== 1) {
    problems.push("current choice opened an unnecessary second snapshot");
  }
  if (delegated.length !== 1 || !sameIdentity(delegateInput(delegated[0]), identity)) {
    problems.push("implicit selection did not delegate the exact selected identity once");
  }
  gradeLaunchState(problems, before, after, identity, parentThreadId);
}

function ordinarySnapshots(executions, identity) {
  return executions.filter((execution) =>
    !detailsInput(execution)?.inspect?.length
    && snapshotHarnesses(execution).includes(identity.harness));
}

function inspectionIdentity(execution, identity) {
  const inspections = detailsInput(execution)?.inspect;
  return Array.isArray(inspections) && inspections.length === 1
    && sameIdentity(inspections[0], identity);
}

function sameIdentity(actual, expected) {
  return actual?.harness === expected?.harness
    && actual?.model === expected?.model
    && actual?.effort === expected?.effort;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function gradeLaunchState(problems, before, after, identity, parentThreadId) {
  const beforeRuns = Array.isArray(before.agentRuns) ? before.agentRuns : [];
  const afterRuns = Array.isArray(after.agentRuns) ? after.agentRuns : [];
  const beforeById = new Map(beforeRuns.map((run) => [run.id, run]));
  const priorChanged = beforeRuns.some((run) => !sameValue(run, afterRuns.find(({ id }) => id === run.id)));
  const added = afterRuns.filter((run) => !beforeById.has(run.id));
  if (priorChanged || added.length !== 1 || !sameIdentity(added[0], identity)
      || added[0]?.parentThreadId !== parentThreadId) {
    problems.push("delegation state did not preserve prior runs and add exactly the selected identity");
  }
}

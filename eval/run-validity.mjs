export function shouldWriteGlobalResults(scope) {
  return scope === "full" || scope === "behavioral";
}

export function validateEvalRun(records, cases, { expectedIds, manifest, repeat, scope }) {
  const reasons = [];
  if (!manifest) reasons.push("missing-manifest");
  if (!manifest?.gitHead) reasons.push("missing-git-commit");
  if (!manifest?.gitBranch || manifest.gitBranch === "HEAD") reasons.push("missing-git-branch");
  const observedIds = new Set(cases.map((item) => item.caseId));
  const missing = [...expectedIds].filter((id) => !observedIds.has(id));
  const extra = [...observedIds].filter((id) => !expectedIds.has(id));
  if (missing.length) reasons.push(`missing-cases:${missing.join("+")}`);
  if (extra.length) reasons.push(`unexpected-cases:${extra.join("+")}`);
  if (records.length !== expectedIds.size * repeat) reasons.push(`records-${records.length}-of-${expectedIds.size * repeat}`);
  if (records.some((item) => item.subject === "unknown")) reasons.push("unknown-subject");
  if (records.some((item) => item.graderError)) reasons.push("grader-error");
  if (records.some((item) => item.correct === null)) reasons.push("missing-grade");
  if (records.some((item) => item.providerError)) reasons.push("provider-error");
  if (records.some((item) => !item.runId)) reasons.push("missing-run-id");
  if (records.some((item) => !item.traceFile)) reasons.push("missing-trace");
  if (records.some((item) => item.manifestHash !== manifest?.manifestHash)) reasons.push("manifest-mismatch");
  if (unique(records.map((item) => item.modelLabel)).length !== 1) reasons.push("model-mismatch");
  if (records.some((item) =>
    item.tokens === null || item.toolCalls === null || item.cost === null || item.latencyMs === null
  )) reasons.push("missing-telemetry");
  if (cases.some((item) => item.stats.n !== repeat)) reasons.push("repeat-mismatch");
  if (scope === "behavioral") {
    if (records.some((item) => item.trajectoryPresent !== true)) reasons.push("missing-behavioral-trajectory");
    if (records.some((item) => item.trajectoryWellFormed !== true)) reasons.push("malformed-behavioral-trajectory");
    if (records.some((item) => item.behavioralStatePresent !== true)) reasons.push("missing-behavioral-state");
    if (records.some((item) => item.harnessValid !== true)) reasons.push("invalid-behavioral-harness");
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function unique(values) { return [...new Set(values)]; }

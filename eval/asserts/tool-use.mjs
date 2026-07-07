// Behavior gate: did OO reach for the right surface? The documented pattern for a
// prose-output CLI agent whose tool calls can't be OTLP-exported — a javascript assertion
// over the provider's metadata (see promptfoo custom-api docs; attested in the wild by
// ooneko/ai-agent-prompts, which asserts `javascript` over `metadata.tools_called`).
//
// The canonical alternative — `trajectory:tool-used` — needs the agent to emit OTLP spans,
// which `oo`/pi don't; `tool-call-f1` is native but scores the EXACT set (extra calls hurt
// precision), so it can't express "must include X, others fine". Hence this.
//
// A case opts in via metadata.expectToolAny (at least one must appear) and/or
// metadata.forbidTool (must NOT appear). Cases without either just pass — the gate is
// per-case, not global.
export default (_output, context) => {
  // The gate is about OO's surface selection; the baseline reaches session-grep through
  // Bash by design, so its tool names aren't comparable — skip it there.
  const arm = context.provider?.label ?? context.provider?.id ?? "";
  if (!arm.startsWith("owner-operator")) return { pass: true, score: 1, reason: "n/a (baseline arm)" };

  const md = context.test?.metadata ?? {};
  const called = new Set((context.providerResponse?.metadata?.toolCalls ?? []).map((t) => t.name));
  const any = md.expectToolAny ?? [];
  const forbid = md.forbidTool ?? [];

  const missingAny = any.length > 0 && !any.some((t) => called.has(t));
  const usedForbidden = forbid.filter((t) => called.has(t));

  const problems = [];
  if (missingAny) problems.push(`expected one of [${any.join(", ")}], got [${[...called].join(", ") || "none"}]`);
  if (usedForbidden.length) problems.push(`used forbidden [${usedForbidden.join(", ")}]`);

  return {
    pass: problems.length === 0,
    score: problems.length === 0 ? 1 : 0,
    reason: problems.length === 0
      ? `tools ok: [${[...called].join(", ") || "none"}]`
      : problems.join("; "),
  };
};

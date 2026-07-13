// Metrics-only assertion: surfaces the provider's efficiency telemetry (tool calls,
// tokens, cost, latency) as named scores so promptfoo aggregates them per subject.
// Always passes — spend is compared downstream by eval/compare.mjs, not gated here.
export default (output, context) => {
  const m = context.providerResponse?.metadata ?? {};
  return {
    pass: true,
    score: 1,
    reason: `cost=$${(m.costUsd ?? 0).toFixed(4)} tokens=${m.tokensTotal ?? 0} toolCalls=${m.toolCallCount ?? 0} turns=${m.numTurns ?? 0}`,
    namedScores: {
      cost_usd: m.costUsd ?? 0,
      tokens_total: m.tokensTotal ?? 0,
      tokens_uncached: m.tokensUncached ?? 0,
      tokens_output: m.tokensOutput ?? 0,
      tool_calls: m.toolCallCount ?? 0,
      tool_result_chars: m.toolResultChars ?? 0,
      turns: m.numTurns ?? 0,
      duration_ms: m.durationMs ?? 0,
    },
  };
};

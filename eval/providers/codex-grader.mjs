// Promptfoo grading provider for llm-rubric assertions, backed by the pi model registry
// on Codex auth — the judge runs on the same subscription as the arms, at minimal
// reasoning, so grading stays cheap. Single turn, no tools: it renders promptfoo's
// grading prompt and returns the model's JSON.

import { completeSimple } from '@earendil-works/pi-ai/compat';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';

// Single source of the judge identity: the run manifest logs these same values.
export const DEFAULT_GRADER_MODEL = 'openai-codex/gpt-5.4';
export const DEFAULT_GRADER_REASONING = 'minimal';

const SYSTEM =
  'You are a strict grader. Judge factual correctness against the rubric ONLY — ignore ' +
  'length, style, and completeness beyond the required core facts; a terse answer with the ' +
  'core facts passes, a long polished answer without them fails. Respond with only the ' +
  'requested JSON, no prose.';

export default class CodexGraderProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.providerId = options.id ?? 'codex-grader';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    // Exact model id: a moving family alias makes longitudinal evals incomparable.
    const spec = process.env.EVAL_GRADER_MODEL ?? this.config.model ?? DEFAULT_GRADER_MODEL;
    const slash = spec.indexOf('/');
    const provider = slash > 0 ? spec.slice(0, slash) : 'openai-codex';
    const modelId = slash > 0 ? spec.slice(slash + 1) : spec;
    try {
      const registry = ModelRegistry.create(AuthStorage.create());
      const model = registry.find(provider, modelId);
      if (!model) throw new Error(`grader model not found: ${spec}`);
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const response = await completeSimple(model, {
        systemPrompt: SYSTEM,
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoning: this.config.reasoning ?? DEFAULT_GRADER_REASONING,
        maxTokens: 4096,
        signal: AbortSignal.timeout(120000),
        maxRetries: 2,
      });
      if (response.stopReason === 'error') {
        throw new Error(response.errorMessage ?? 'unknown provider error');
      }
      const output = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const usage = response.usage ?? {};
      return {
        output,
        cost: usage.cost?.total ?? 0,
        tokenUsage: {
          total: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
          prompt: usage.input ?? 0,
          completion: usage.output ?? 0,
        },
      };
    } catch (error) {
      return { output: '', error: String(error?.message ?? error) };
    }
  }
}

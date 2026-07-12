// Promptfoo grading provider for llm-rubric assertions, backed by `claude -p` so the
// whole harness runs on Claude Code auth — no ANTHROPIC_API_KEY required. Single turn,
// no tools: it just renders promptfoo's grading prompt and returns the model's JSON.

import { execFile } from 'node:child_process';

const NO_TOOLS = 'Agent,Task,Skill,Bash,Read,Write,Edit,MultiEdit,Grep,Glob,WebSearch,WebFetch,TodoWrite,NotebookEdit';

export default class ClaudeGraderProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.providerId = options.id ?? 'claude-grader';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    // Exact model id: a moving family alias makes longitudinal evals incomparable.
    const model = process.env.EVAL_GRADER_MODEL ?? this.config.model ?? 'claude-fable-5';
    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'json',
      '--max-turns', '3',
      '--disallowedTools', NO_TOOLS,
      // Verbosity-bias guard: judges prefer longer answers, and the arm under test is
      // SUPPOSED to answer shorter/cheaper — judge only the rubric's core facts.
      '--append-system-prompt', 'You are a strict grader. Judge factual correctness against the rubric ONLY — ignore length, style, and completeness beyond the required core facts; a terse answer with the core facts passes, a long polished answer without them fails. Respond with only the requested JSON, no prose.',
      '--strict-mcp-config',
      '--setting-sources', '',
    ];
    const result = await new Promise((resolve, reject) => {
      execFile('claude', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(stdout);
      });
    }).catch((err) => ({ error: String(err) }));

    if (result.error) return { output: '', error: result.error };
    try {
      const envelope = JSON.parse(result);
      const u = envelope.usage ?? {};
      return {
        output: envelope.result ?? '',
        cost: envelope.total_cost_usd ?? 0,
        tokenUsage: {
          total: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          prompt: u.input_tokens ?? 0,
          completion: u.output_tokens ?? 0,
        },
      };
    } catch {
      return { output: result };
    }
  }
}

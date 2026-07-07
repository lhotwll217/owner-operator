// The controlled baseline arm: same `oo` binary + same model as the OO arm, but
// OO_EVAL_BASELINE_PROMPT swaps in a generic session-search prompt and restricts the
// toolset to search_sessions only (no DB/state tools). So this arm differs from
// owner-operator by exactly its prompt + toolset — the ablation of OO's composition.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePiAgentProvider } from './pi-agent-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePrompt = path.resolve(here, '..', 'fixtures', 'naive-baseline-prompt.md');

export default makePiAgentProvider({ arm: 'baseline', env: { OO_EVAL_BASELINE_PROMPT: baselinePrompt } });

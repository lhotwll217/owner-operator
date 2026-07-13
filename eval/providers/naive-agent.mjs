// The naive-session-grep control: same `oo` binary + same model as the owner-operator
// subject, but OO_EVAL_BASELINE_PROMPT swaps in a generic session-search composition while
// withholding OO's state/index capabilities. The agent factory owns the concrete roster;
// this provider owns only the subject selection.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePiAgentProvider } from './pi-agent-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePrompt = path.resolve(here, '..', 'fixtures', 'naive-baseline-prompt.md');

export default makePiAgentProvider({ arm: 'naive-session-grep', env: { OO_EVAL_BASELINE_PROMPT: baselinePrompt } });

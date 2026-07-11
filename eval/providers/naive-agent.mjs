// The controlled baseline arm: same `oo` binary + same model as the OO arm, but
// OO_EVAL_BASELINE_PROMPT swaps in a generic session-search composition while withholding OO's
// state/index capabilities. The agent factory owns the concrete roster; this provider owns only
// the controlled arm selection.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePiAgentProvider } from './pi-agent-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePrompt = path.resolve(here, '..', 'fixtures', 'naive-baseline-prompt.md');

export default makePiAgentProvider({ arm: 'baseline', env: { OO_EVAL_BASELINE_PROMPT: baselinePrompt } });

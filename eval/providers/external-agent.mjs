// External coding-agent subjects: Claude Code or Codex, through Promptfoo's native SDK
// providers, driving the measured checkout's owner-operator skill and `oo` CLI. The shared
// runner owns the per-sample worker (eval/external/trial.mjs); config.harness selects the arm.
import { makePiAgentProvider } from './pi-agent-core.mjs';

export default class ExternalAgentProvider {
  constructor(options = {}) {
    const Provider = makePiAgentProvider({ arm: `external-${options.config?.harness}`, profile: 'external' });
    return new Provider(options);
  }
}

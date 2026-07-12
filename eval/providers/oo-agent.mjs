// The subject arm: Owner Operator's shipped read-only composition. The agent factory owns the
// concrete tool roster; this provider only selects the arm.
import { makePiAgentProvider } from './pi-agent-core.mjs';

export default makePiAgentProvider({ arm: 'owner-operator' });

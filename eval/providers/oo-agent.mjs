// The subject arm: Owner Operator as shipped — its prompt, its full toolset (query_database,
// get_current_session_state, read, bash, …). Shared runner in pi-agent-core.mjs.
import { makePiAgentProvider } from './pi-agent-core.mjs';

export default makePiAgentProvider({ arm: 'owner-operator' });

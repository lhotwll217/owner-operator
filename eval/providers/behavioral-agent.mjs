// Opt-in mutable subject: same production session factory and configured roster, with one
// pristine sandbox user + daemon per Promptfoo sample/repeat.
import { makePiAgentProvider } from "./pi-agent-core.mjs";

export default makePiAgentProvider({
  arm: "owner-operator-behavioral",
  profile: "mark-done",
});

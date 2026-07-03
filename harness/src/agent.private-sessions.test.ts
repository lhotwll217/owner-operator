// Unit: the private (agent-to-agent) agent persists ONLY under oo's own home, never pi's
// default ~/.pi/agent/sessions. Locks the isolation invariant so a future refactor can't
// silently point the neutral agent at pi's session dir.
import assert from "node:assert";
import { join } from "node:path";

process.env.OO_HOME = join(process.cwd(), ".oo-home-fixture"); // set before importing the module
const { agentSessionsDir } = await import("./agent");

assert.equal(agentSessionsDir(), join(process.env.OO_HOME, "agent-sessions"), "dir is <OO_HOME>/agent-sessions");
assert.ok(!agentSessionsDir().includes(`${".pi"}/`), "never under pi's session dir");

process.stdout.write("ok — private-agent sessions: pinned to <OO_HOME>/agent-sessions, not pi's dir\n");

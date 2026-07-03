// Unit: oo's saved-sessions policy. (1) Threads persist ONLY under oo's own home, never
// pi's default ~/.pi/agent/sessions — locks the isolation invariant. (2) Every stamp is an
// oo-provenance entry labeling surface/origin/caller repo (+ the calling session id when
// given), and re-stamping a resumed thread accrues an audit trail.
import assert from "node:assert";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

process.env.OO_HOME = join(process.cwd(), ".oo-home-fixture"); // set before importing the module
const { ooSessionsDir, ooProvenance, stampProvenance } = await import("./agent");

assert.equal(ooSessionsDir(), join(process.env.OO_HOME, "sessions"), "dir is <OO_HOME>/sessions");
assert.ok(!ooSessionsDir().includes(`${".pi"}/`), "never under pi's session dir");

const p = ooProvenance("one-shot", "caller-session-123");
assert.equal(p.origin, "agent", "one-shot is the agent channel");
assert.equal(p.fromSession, "caller-session-123", "--from-session lands in provenance");
assert.equal(p.callerRepo, "owner-operator", "caller repo derived from the invoking git checkout");
assert.equal(ooProvenance("tui").origin, "owner", "tui is an owner surface");

// Stamp in-memory (same append path as on disk): entry + human-readable session name.
const sm = SessionManager.inMemory(process.cwd());
stampProvenance(sm, p);
const stamps = sm.getEntries().filter((e: any) => e.type === "custom" && e.customType === "oo-provenance");
assert.equal(stamps.length, 1, "one provenance stamp per invocation");
assert.equal((stamps[0] as any).data.surface, "one-shot", "stamp carries the surface");
assert.equal(sm.getSessionName(), "one-shot ← caller-session-123 @ owner-operator", "session named for pickers/greps");

stampProvenance(sm, ooProvenance("one-shot", "caller-session-456")); // a later resume by someone else
const trail = sm.getEntries().filter((e: any) => e.type === "custom" && e.customType === "oo-provenance");
assert.deepEqual(trail.map((e: any) => e.data.fromSession), ["caller-session-123", "caller-session-456"], "resumes accrue an audit trail");

process.stdout.write("ok — oo sessions: pinned to <OO_HOME>/sessions, provenance labels + audit trail stamp correctly\n");

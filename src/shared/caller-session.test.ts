// Unit: caller and parent session resolution from flags and environment. No disk.
import assert from "node:assert";
import { callerSessionId, parentSessionId } from "./caller-session";

const KEYS = ["OO_FROM_SESSION", "CODEX_THREAD_ID", "OO_CURRENT_SESSION_ID"] as const;
const withEnv = <T>(env: Partial<Record<(typeof KEYS)[number], string>>, read: () => T): T => {
  const prior = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return read();
  } finally {
    for (const key of KEYS) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
};

assert.equal(withEnv({}, () => parentSessionId()), undefined, "no identity, no parent");
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: " operator " }, () => parentSessionId()), "operator",
  "the Operator's own bash names its session as the parent");
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: "operator" }, () => callerSessionId()), undefined,
  "the caller id never reads the Operator's current session");
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: "operator", OO_FROM_SESSION: "coder" }, () => parentSessionId("spoofed")), "operator",
  "inside an Operator, a model-supplied --from-session cannot replace the session's own lineage");
assert.equal(withEnv({ OO_FROM_SESSION: "coder" }, () => parentSessionId("flag")), "flag",
  "outside an Operator, an explicit --from-session wins");
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: "operator", OO_FROM_SESSION: "coder" }, () => parentSessionId()), "operator",
  "the current Operator session outranks the coding session that called it");
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: "  ", CODEX_THREAD_ID: "codex" }, () => parentSessionId()), "codex",
  "outside an Operator, the caller session is the parent");

process.stdout.write("ok — parent session: the current Operator session, then explicit, then the caller\n");

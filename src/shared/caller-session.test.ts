// Unit: caller and parent session resolution from flags and environment. No disk.
import assert from "node:assert";
import { callerSessionId, parentSessionId } from "./caller-session";

const KEYS = ["OO_FROM_SESSION", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "OO_CURRENT_SESSION_ID"] as const;
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
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: "operator", OO_FROM_SESSION: "coder" }, () => parentSessionId("flag")), "flag",
  "an explicit --from-session wins");
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: "operator", OO_FROM_SESSION: "coder" }, () => parentSessionId()), "operator",
  "the current Operator session outranks the coding session that called it");
assert.equal(withEnv({ OO_CURRENT_SESSION_ID: "  ", CODEX_THREAD_ID: "codex" }, () => parentSessionId()), "codex",
  "outside an Operator, the caller session is the parent");
assert.equal(withEnv({ CLAUDE_CODE_SESSION_ID: "claude" }, () => callerSessionId()), "claude",
  "a Claude Code session identifies itself without a flag");
assert.equal(withEnv({ CODEX_THREAD_ID: "codex", CLAUDE_CODE_SESSION_ID: "claude" }, () => callerSessionId()), "codex",
  "Codex's own thread id outranks a Claude Code id inherited from an enclosing shell");

process.stdout.write("ok — caller session: explicit, then the current Operator session, then Codex or Claude Code\n");

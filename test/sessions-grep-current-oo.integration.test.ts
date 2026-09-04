import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SEARCH = join(here, "..", "src/agent/skills/session-search/scripts/session-search.mjs");
const SESSION_ID = "01a06c11-58bd-7938-a429-ef77a510bd7e";
const TRANSCRIPT_NAME = `2026-09-04T10-57-51-293Z_${SESSION_ID}.jsonl`;
const NEEDLE = "ZZCURRENTOWNEROPERATORSESSIONZZ";

const home = mkdtempSync(join(tmpdir(), "oo-current-session-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-current-session-oohome-"));

try {
  const sessionsDir = join(ooHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, TRANSCRIPT_NAME),
    [
      { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-04T10:57:51.293Z", cwd: home },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-09-04T10:57:52.000Z",
        message: { role: "assistant", content: [{ type: "text", text: NEEDLE }] },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );

  const results = [[], ["--owner-operator"]].map((args) => JSON.parse(execFileSync(
    process.execPath,
    [SEARCH, "--query", NEEDLE, "--json", ...args],
    {
      env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CURRENT_SESSION_ID: SESSION_ID },
      encoding: "utf8",
    },
  )));

  assert.deepEqual(
    results.map((result) => result.discoverySessionExclusions),
    Array.from({ length: 2 }, () => ({ applied: true, sessionIds: [SESSION_ID] })),
    "the shipped wrapper reports the stable current OO session ID as excluded in both modes",
  );
  assert.deepEqual(
    results.map((result) => result.matches.map((match: { id: string }) => match.id)),
    [[], []],
    "default and OO-only discovery exclude the current timestamp-prefixed OO transcript",
  );
  process.stdout.write("ok — timestamp-prefixed current OO session excluded from both discovery modes\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

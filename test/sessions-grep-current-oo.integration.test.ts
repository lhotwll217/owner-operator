import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (spawnSync("rg", ["--version"], { stdio: "ignore" }).status !== 0) {
  process.stdout.write("skip — ripgrep (rg) not installed; current OO session exclusion test needs it\n");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const SEARCH = join(here, "..", "src/agent/skills/session-search/scripts/session-search.mjs");
const SESSION_ID = "01a06c11-58bd-7938-a429-ef77a510bd7e";
const OTHER_SESSION_ID = "01a06c11-58bd-7938-a429-ef77a510bd7f";
const OTHER_TRANSCRIPT_ID = `2026-09-04T10-58-51-293Z_${OTHER_SESSION_ID}`;
const NEEDLE = "ZZCURRENTOWNEROPERATORSESSIONZZ";

const home = mkdtempSync(join(tmpdir(), "oo-current-session-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-current-session-oohome-"));

try {
  const sessionsDir = join(ooHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const writeSession = (id: string, timestamp: string) =>
    writeFileSync(
      join(sessionsDir, `${timestamp.replaceAll(":", "-").replace(".", "-")}_${id}.jsonl`),
      [
        { type: "session", version: 3, id, timestamp, cwd: home },
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-09-04T10:57:52.000Z",
          message: { role: "assistant", content: [{ type: "text", text: NEEDLE }] },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
  writeSession(SESSION_ID, "2026-09-04T10:57:51.293Z");
  writeSession(OTHER_SESSION_ID, "2026-09-04T10:58:51.293Z");

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
    results.map((result) => result.matches.map(
      (match: { id: string; namespace?: string; source?: string; app?: string }) => ({
        id: match.id,
        namespace: match.namespace,
        source: match.source,
        app: match.app,
      }),
    )),
    Array.from({ length: 2 }, () => [{
      id: OTHER_TRANSCRIPT_ID,
      namespace: "owner-operator",
      source: "pi",
      app: "Owner Operator",
    }]),
    "both modes exclude only the current transcript and retain another timestamp-prefixed OO match",
  );
  process.stdout.write("ok — both modes exclude the current timestamp-prefixed OO session and retain another\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

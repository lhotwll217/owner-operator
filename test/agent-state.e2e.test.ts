import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOwnerOperatorWorkspace, markOnboarded } from "@owner-operator/core";

const fixture = fileURLToPath(new URL("fixtures/agent-state-pty.ts", import.meta.url));
const ooHome = mkdtempSync(join(tmpdir(), "oo-agent-state-pty-"));
const actionFile = join(ooHome, "actions.log");
const paths = ensureOwnerOperatorWorkspace(ooHome);
markOnboarded(ooHome, { via: "agent-state-pty" });
writeFileSync(paths.piSettings, JSON.stringify({ quietStartup: true, lastChangelogVersion: "0.80.6" }));

try {
  const result = spawnSync(
    "/usr/bin/expect",
    [
      "-c",
      [
        "set timeout 12",
        "spawn $env(OO_TEST_NODE) --import tsx $env(OO_TEST_FIXTURE)",
        "stty rows 30 columns 40",
        "expect -exact \"Agent state: 1 running\"",
        "send \"/agent-state\\r\"",
        "expect -exact \"Task:\"",
        "send \"c\"",
        "expect -exact \"Cancel delegated agent?\"",
        "send \"\\r\"",
        "after 250",
        "send \"/quit\\r\"",
        "expect eof",
      ].join("; "),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_USE_SYSTEM_CA: "0",
        OO_HOME: ooHome,
        OO_TEST_ACTION_FILE: actionFile,
        OO_TEST_NODE: process.execPath,
        OO_TEST_FIXTURE: fixture,
        PI_OFFLINE: "1",
      },
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const readable = result.stdout
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
  assert.match(readable, /Agent state: 1 running/);
  assert.match(readable, /Selected · ● running/);
  assert.match(readable, /Task:/);
  assert.match(readable, /Status:/);
  assert.match(readable, /Activity:/);
  assert.match(readable, /Cancel delegated agent\?/);
  assert.equal(readFileSync(actionFile, "utf8"), "cancel:running\n");

  process.stdout.write("ok — real Pi PTY renders the footer, /agent-state picker, and confirmed control at 40 columns\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

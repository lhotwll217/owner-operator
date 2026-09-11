import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOwnerOperatorWorkspace, markOnboarded } from "@owner-operator/core";

const fixture = fileURLToPath(new URL("fixtures/agent-run-delivery-pty.ts", import.meta.url));
const ooHome = mkdtempSync(join(tmpdir(), "oo-agent-run-delivery-pty-"));
const actionFile = join(ooHome, "actions.log");
const paths = ensureOwnerOperatorWorkspace(ooHome);
markOnboarded(ooHome, { via: "agent-run-delivery-pty" });
writeFileSync(paths.piSettings, JSON.stringify({ quietStartup: true, lastChangelogVersion: "0.85.0" }));

try {
  const result = spawnSync(
    "/usr/bin/expect",
    [
      "-c",
      [
        "set timeout 12",
        'spawn /bin/sh -c {stty rows 30 columns 40; exec "$OO_TEST_NODE" --import tsx "$OO_TEST_FIXTURE"}',
        'expect { -exact "Fixture ready" {} timeout { exit 1 } eof { exit 1 } }',
        "send \"/test-complete\\r\"",
        'expect { -exact "Completion received by parent." {} timeout { exit 1 } eof { exit 1 } }',
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
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const readable = result.stdout
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
  assert.doesNotMatch(readable, /Agent state|\/agent-state|● 1 running|enter inspect/);
  assert.match(readable, /Review reconnect behavior/);
  assert.match(readable, /completed/);
  assert.match(readable, /Completion received by parent\./);
  assert.equal(readFileSync(actionFile, "utf8"), "completed-without-agent-state-command\n");

  process.stdout.write("ok — real Pi PTY delivers child completion without Agent state UI at 40 columns\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

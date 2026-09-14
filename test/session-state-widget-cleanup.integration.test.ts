import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionStateWidgetProof } from "./session-state-widget-proof";

const root = mkdtempSync(join(tmpdir(), "oo-widget-cleanup-"));
try {
  const credentials = join(root, "fake-credentials");
  const scratch = join(root, "scratch");
  mkdirSync(credentials);
  mkdirSync(scratch);
  const fakeSecret = "FAKE-CREDENTIAL-CLEANUP-SENTINEL";
  writeFileSync(join(credentials, "auth.json"), JSON.stringify({ fake: fakeSecret }));
  const result = spawnSync(process.execPath, ["--import", "tsx", "test/session-state-widget.live.test.ts"], {
    env: { PATH: process.env.PATH, HOME: root, OO_HOME: root, TMPDIR: scratch,
      OO_WIDGET_PROOF_LIVE: "1", OO_WIDGET_PROOF_CREDENTIAL_SOURCE: credentials },
    encoding: "utf8", timeout: 15_000,
  });
  assert.notEqual(result.status, 0, "partial credential copy fails before inference");
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fakeSecret), "failure output never prints credentials");
  assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith("oo-widget-proof-")), [], "setup failure deletes the disposable home and copied credential");
  writeFileSync(join(credentials, "models-store.json"), "{}");
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const before = { ...process.env };
  try {
    await assert.rejects(runSessionStateWidgetProof({ live: { credentialSource: credentials,
      loadEnrichment: async () => (await import(new URL("./absent-widget-proof.ts", import.meta.url).href)).enrichThread,
    } }), /Cannot find module/);
    assert.deepEqual({ ...process.env }, before, "import failure restores the caller environment");
    assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith("oo-widget-proof-")), [], "import failure deletes copied credentials and fixtures");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
  }
  console.log("ok - widget proof removes copied credentials after setup and import failures and restores environment");
} finally {
  rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMarkDoneBehaviorFixture } from "../eval/behavioral/mark-done-fixture.mjs";

const root = mkdtempSync(join(tmpdir(), "oo-mark-done-fixture-"));
const common = {
  root,
  taskCwd: join(root, "task"),
  parentThreadId: "parent-129",
  childSessionId: "child-129",
  sentinelSessionId: "sentinel-129",
  parentContext: "Please have a child update the release checklist and validate it.",
  now: "2026-08-20T12:00:00.000Z",
};

try {
  const finished = buildMarkDoneBehaviorFixture({
    ...common,
    shouldMarkDone: true,
    result: "The checklist update is complete and all 18 validation checks passed. No blocker or remaining child action exists.",
  });
  const unresolved = buildMarkDoneBehaviorFixture({
    ...common,
    shouldMarkDone: false,
    result: "The checklist update is incomplete because the signing key is unavailable. I need the owner to choose a key before I can continue.",
  });

  assert.equal(finished.run.outcome.status, "completed");
  assert.equal(unresolved.run.outcome.status, "completed", "semantic evidence changes while lifecycle stays fixed");
  assert.equal(finished.run.create.childSessionId, common.childSessionId);
  assert.equal(unresolved.run.create.childSessionId, common.childSessionId);
  assert.deepEqual(finished.rows.map(({ id }) => id).sort(), ["child-129", "sentinel-129"]);
  assert.deepEqual(unresolved.rows.map(({ id }) => id).sort(), ["child-129", "sentinel-129"]);
  assert.equal(finished.rows.every(({ transcriptPath }) => readFileSync(transcriptPath, "utf8").includes("sanitized eval fixture")), true);
  assert.equal(finished.expected.shouldMarkDone, true);
  assert.equal(unresolved.expected.shouldMarkDone, false);
  assert.doesNotMatch(finished.parentContext, /mark.*done|clean.?up|retire/i, "the parent context does not encode the expected tool");
  assert.doesNotMatch(unresolved.run.outcome.resultTail!, /mark.*done|clean.?up|retire/i, "the evidence does not encode cleanup");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — mark-done fixture: same completed lifecycle, semantic evidence split, child plus sentinel\n");

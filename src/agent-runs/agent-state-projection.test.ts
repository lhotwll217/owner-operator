import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunStatus } from "@owner-operator/core";
import { agentRunFixture as run } from "../../test/fixtures/agent-run";
import {
  resumeCwdError,
  deriveParentAgentStateWithEnvironment,
} from "./agent-state-projection";

const root = mkdtempSync(join(tmpdir(), "oo-agent-state-projection-"));
try {
  const file = join(root, "not-a-directory");
  writeFileSync(file, "fixture");
  const rows = [
    run("existing-cwd", AgentRunStatus.Completed, {
      cwd: root,
      childSessionId: "existing-child",
      acpxRecordId: "existing-acpx",
    }),
    run("missing-cwd", AgentRunStatus.Completed, {
      cwd: join(root, "missing"),
      childSessionId: "missing-child",
      acpxRecordId: "missing-acpx",
    }),
    run("file-cwd", AgentRunStatus.Completed, {
      cwd: file,
      childSessionId: "file-child",
      acpxRecordId: "file-acpx",
    }),
  ];
  const view = deriveParentAgentStateWithEnvironment(rows, {
    now: "2026-07-21T12:10:00.000Z",
  });
  assert.equal(view.runs.find(({ id }) => id === "existing-cwd")?.canResume, true);
  assert.equal(view.runs.find(({ id }) => id === "missing-cwd")?.canResume, false);
  assert.equal(view.runs.find(({ id }) => id === "file-cwd")?.canResume, false);
  assert.match(resumeCwdError(join(root, "missing")) ?? "", /no longer exists/);
  assert.match(resumeCwdError(file) ?? "", /not a directory/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — agent-state resume controls require a live workspace directory\n");

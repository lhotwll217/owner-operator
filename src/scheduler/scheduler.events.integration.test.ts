import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScheduleKind,
  ScheduledPayloadKind,
  type ScanRow,
  type ScheduleExecutionResult,
} from "@owner-operator/core";
import { waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { Scheduler, type PromptExecutionRequest } from "./scheduler";

const dir = mkdtempSync(join(tmpdir(), "oo-scheduler-events-"));
const state = new State(join(dir, "state.db"));
const contexts: unknown[] = [];
const scheduler = new Scheduler(state, {
  tickMs: 60_000,
  promptRunner: async (request: PromptExecutionRequest): Promise<ScheduleExecutionResult> => {
    contexts.push(request.triggerContext);
    return { exitCode: 0, stdout: "handled", stderr: "", transcriptId: `transcript-${contexts.length}` };
  },
});

const row = (id: string, lastMessageAt: string): ScanRow => ({
  id, source: "codex", repo: "demo", app: "Codex", topic: id,
  lastRole: "assistant", working: false,
  createdAt: "2026-07-09T09:00:00.000Z", lastMessageAt,
  secondsSinceLastMessage: 10, secondsSinceActivity: 10,
});

try {
  const job = scheduler.createSchedule({
    name: "needs-you brief",
    enabled: true,
    trigger: { kind: ScheduleKind.NeedsYou },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "Brief me" },
    cwd: dir,
    timeoutSeconds: 1_800,
  });
  scheduler.start();

  state.recordPoll([
    row("a", "2026-07-09T10:00:00.000Z"),
    row("b", "2026-07-09T10:01:00.000Z"),
  ]);
  await waitFor(() => contexts.length === 1, 1_000, "batched needs-you run");
  assert.deepEqual(contexts[0], {
    threadIds: ["a", "b"],
    observedThrough: "2026-07-09T10:01:00.000Z",
  });

  state.recordPoll([
    row("a", "2026-07-09T10:00:00.000Z"),
    row("b", "2026-07-09T10:01:00.000Z"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 1, "persisted watermarks suppress duplicate messages");

  state.recordObservation(row("a", "2026-07-09T10:02:00.000Z"));
  await waitFor(() => contexts.length === 2, 1_000, "same-state new-message run");
  assert.equal(state.listScheduleRuns(job.id).length, 2);

  process.stdout.write("ok — needs-you event batching and durable dedupe\n");
} finally {
  scheduler.stop();
  state.close();
  rmSync(dir, { recursive: true, force: true });
}

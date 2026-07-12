import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DomainEventKind,
  ScheduleKind,
  ScheduledPayloadKind,
  type DomainEvent,
  type ScanRow,
  type ScheduleDefinition,
} from "@owner-operator/core";
import { InMemoryEventBus } from "./event-bus";
import { State } from "./state";

const dir = mkdtempSync(join(tmpdir(), "oo-state-api-"));
const events: DomainEvent[] = [];
const bus = new InMemoryEventBus();
bus.subscribe((event) => { events.push(event); });

const row = (lastMessageAt: string): ScanRow => ({
  id: "thread-1",
  source: "codex",
  repo: "owner-operator",
  project: dir,
  app: "Codex",
  topic: "Design the daemon",
  lastRole: "assistant",
  createdAt: "2026-07-09T09:00:00.000Z",
  lastMessageAt,
  secondsSinceLastMessage: 30,
  secondsSinceActivity: 30,
  working: false,
});

try {
  process.env.OO_HOME = dir;
  writeFileSync(join(dir, "blacklist.json"), JSON.stringify({ paths: [], repos: ["private-repo"] }));
  const state = new State(join(dir, "state.db"), {
    bus,
    now: () => "2026-07-09T10:00:00.000Z",
    activeWindow: "1d",
  });

  state.recordObservation(row("2026-07-09T09:59:00.000Z"));
  state.recordObservation({
    ...row("2026-07-09T09:59:30.000Z"),
    id: "private-thread",
    repo: "private-repo",
  });
  assert.ok(!state.listSessionState().some((item) => item.id === "private-thread"), "State rejects blacklisted writes");
  state.recordObservation({
    ...row("2026-07-07T09:59:00.000Z"),
    id: "thread-old-working",
    working: true,
  });
  state.recordObservation({
    ...row("2026-07-09T09:58:00.000Z"),
    id: "legacy-plugin-noise",
    topic: "<recommended_plugins>injected connector catalog</recommended_plugins>",
  });
  state.recordObservation({
    ...row("2026-07-09T09:58:30.000Z"),
    id: "generated-review-topic",
    topic: "Review the current code changes",
  });
  assert.equal(
    state.appendEnrichment(
      "generated-review-topic",
      { topic: "Review the current code changes for billing" },
      "2026-07-09T09:58:30.000Z",
    ),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.listSessionState()[0].state, "needs-you");
  assert.ok(
    !state.listSessionState().some((item) => item.id === "legacy-plugin-noise"),
    "legacy injected topics remain durable but do not surface in current state",
  );
  assert.ok(
    state.listSessionState().some((item) => item.id === "generated-review-topic"),
    "a generated title that resembles transport boilerplate remains visible",
  );
  assert.ok(state.listSessionState().some((item) => item.id === "thread-old-working"), "history is retained");
  assert.ok(
    !state.listCurrentSessionState().some((item) => item.id === "thread-old-working"),
    "quiet rows outside the active window leave the client projection",
  );
  assert.deepEqual(state.listEnrichmentCandidates().map((item) => item.id), ["thread-1"]);
  assert.equal(events.at(-1)?.kind, DomainEventKind.ThreadChanged, "post-commit event published");

  state.appendEnrichment(
    "thread-1",
    { topic: "Daemon foundation", nextSteps: "Implement the state seam", priority: 4 },
    "2026-07-09T09:59:00.000Z",
  );
  const gatewayFixture = JSON.parse(readFileSync(
    new URL("../../apps/widget/Tests/Fixtures/session-state.gateway.json", import.meta.url),
    "utf8",
  )) as unknown[];
  assert.deepEqual(
    state.listCurrentSessionState().filter((item) => item.id === "thread-1"),
    gatewayFixture,
    "the shared widget fixture is captured from the public state projection",
  );
  assert.deepEqual(state.listEnrichmentCandidates(), [], "watermark suppresses unchanged needs-you state");

  state.recordObservation(row("2026-07-09T10:01:00.000Z"));
  assert.deepEqual(
    state.listEnrichmentCandidates().map((item) => item.id),
    ["thread-1"],
    "a newer assistant message refreshes enrichment without a state transition",
  );
  assert.equal(
    state.appendEnrichment(
      "thread-1",
      { topic: "Stale title", nextSteps: "Stale action", priority: 1 },
      "2026-07-09T09:59:00.000Z",
    ),
    false,
    "an enrichment for an older message cannot overwrite the current handoff",
  );
  assert.equal(state.listSessionState()[0].nextSteps, "Implement the state seam");

  assert.deepEqual(state.markThreadsDone(["thread-1", "missing"]).missingIds, ["missing"]);
  assert.ok(!state.listSessionState().some((item) => item.id === "thread-1"), "done leaves the active projection");
  const eventsAfterDone = events.length;
  const alreadyDone = state.markThreadsDone(["thread-1"]);
  assert.deepEqual(alreadyDone.marked, [], "an idempotent done request reports no new transition");
  assert.deepEqual(alreadyDone.alreadyDoneIds, ["thread-1"], "an idempotent done request is explicit");
  assert.deepEqual(alreadyDone.missingIds, [], "an existing done thread is not reported missing");
  assert.equal(events.length, eventsAfterDone, "an idempotent done request emits no false state change");
  state.recordObservation(row("2026-07-09T10:01:00.000Z"));
  assert.ok(!state.listSessionState().some((item) => item.id === "thread-1"), "same message cannot resurrect owner-set done");
  state.recordObservation(row("2026-07-09T10:02:00.000Z"));
  assert.equal(state.listSessionState()[0].state, "needs-you", "new transcript activity reopens done");

  const needsYouSchedule: ScheduleDefinition = {
    id: "needs-you-job",
    name: "Needs you job",
    enabled: true,
    trigger: { kind: ScheduleKind.NeedsYou },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "Summarize it" },
    cwd: dir,
    timeoutSeconds: 60,
    revision: 1,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    nextRunAt: null,
  };
  state.saveSchedule(needsYouSchedule);
  assert.ok(state.claimNeedsYouScheduleRun(needsYouSchedule, [
    { threadId: "thread-1", lastMessageAt: "2026-07-09T10:02:00.000Z" },
  ]));
  state.close();

  writeFileSync(join(dir, "blacklist.json"), JSON.stringify({ paths: [], repos: ["owner-operator"] }));
  const reopened = new State(join(dir, "state.db"), {
    now: () => "2026-07-09T10:03:00.000Z",
    activeWindow: "1d",
  });
  assert.deepEqual(reopened.listSessionState(), [], "open-time purge removes newly blacklisted durable rows");
  reopened.close();
  process.stdout.write("ok — public state seam\n");
} finally {
  delete process.env.OO_HOME;
  rmSync(dir, { recursive: true, force: true });
}

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainEventKind, type DomainEvent, type ScanRow } from "@owner-operator/core";
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
  const state = new State(join(dir, "state.db"), {
    bus,
    now: () => "2026-07-09T10:00:00.000Z",
    activeWindow: "1d",
  });

  state.recordObservation(row("2026-07-09T09:59:00.000Z"));
  state.recordObservation({
    ...row("2026-07-07T09:59:00.000Z"),
    id: "thread-old-working",
    working: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.listSessionState()[0].state, "needs-you");
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
  state.recordObservation(row("2026-07-09T10:01:00.000Z"));
  assert.ok(!state.listSessionState().some((item) => item.id === "thread-1"), "same message cannot resurrect owner-set done");
  state.recordObservation(row("2026-07-09T10:02:00.000Z"));
  assert.equal(state.listSessionState()[0].state, "needs-you", "new transcript activity reopens done");

  state.close();
  process.stdout.write("ok — public state seam\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

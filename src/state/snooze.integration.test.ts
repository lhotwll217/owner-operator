import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DomainEventKind, type DomainEvent, type ScanRow } from "@owner-operator/core";
import { ThreadDb } from "./database";
import { InMemoryEventBus } from "./event-bus";
import { State } from "./state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";

const { dir, cleanup } = tempOoHome("oo-snooze");
let now = "2026-07-09T10:00:00.000Z";
const clock = { now: () => now, activeWindow: "1d" };
const row = (id: string, lastMessageAt: string, overrides: Partial<ScanRow> = {}): ScanRow =>
  fakeScanRow({ id, createdAt: "2026-07-01T00:00:00.000Z", lastMessageAt, ...overrides });

try {
  const events: DomainEvent[] = [];
  const bus = new InMemoryEventBus();
  bus.subscribe((event) => { events.push(event); });
  const path = join(dir, "state.db");
  const state = new State(path, { ...clock, bus });
  const visible = (id: string) => state.listCurrentSessionState().find((item) => item.id === id);

  // A timed snooze holds until its instant passes on the injected clock; state is untouched.
  state.recordObservation(row("timed", "2026-07-09T09:59:00.000Z"));
  state.appendEnrichment("timed", { topic: "Pick a retention policy", statusSummary: "Asks which policy.", priority: 3, attention: "needs-you" }, "2026-07-09T09:59:00.000Z");
  assert.equal(state.snoozeThread("timed", { kind: "until", until: "2026-07-09T14:00:00+02:00" }), "applied");
  assert.deepEqual(
    { section: visible("timed")?.section, state: visible("timed")?.state, snooze: visible("timed")?.snooze },
    { section: "snoozed", state: "needs-you", snooze: { kind: "until", until: "2026-07-09T12:00:00.000Z" } },
    "a held snooze moves the row to Snoozed, keeps its state, and reports the instant in canonical ISO",
  );
  now = "2026-07-09T11:59:59.999Z";
  assert.equal(visible("timed")?.section, "snoozed", "the snooze holds until its instant");
  now = "2026-07-09T12:00:00.000Z";
  assert.deepEqual(
    { section: visible("timed")?.section, snooze: visible("timed")?.snooze },
    { section: "needs-you", snooze: null },
    "at its instant the row wakes into its state's section with no write",
  );

  // A next-message snooze holds through re-observation of the same message; a newer one wakes it.
  state.recordObservation(row("quiet", "2026-07-09T11:00:00.000Z"));
  assert.equal(state.snoozeThread("quiet", { kind: "next-message" }), "applied");
  state.recordObservation(row("quiet", "2026-07-09T11:00:00.000Z"));
  assert.deepEqual(visible("quiet")?.snooze, { kind: "next-message" }, "the message it was set against does not wake it");
  state.recordObservation(row("quiet", "2026-07-09T11:30:00.000Z"));
  assert.deepEqual(
    { section: visible("quiet")?.section, snooze: visible("quiet")?.snooze },
    { section: "idle", snooze: null },
    "a newer message wakes a snoozed row",
  );

  // A newer message also wakes a timed snooze before its instant.
  state.recordObservation(row("early", "2026-07-09T11:00:00.000Z"));
  state.snoozeThread("early", { kind: "until", until: "2026-07-10T09:00:00.000Z" });
  state.recordObservation(row("early", "2026-07-09T11:45:00.000Z"));
  assert.equal(visible("early")?.snooze, null, "a newer message wakes a timed snooze early");

  // Done wins over a held snooze.
  state.recordObservation(row("closed", "2026-07-09T11:00:00.000Z"));
  state.snoozeThread("closed", { kind: "next-message" });
  state.markThreadsDone(["closed"]);
  assert.equal(visible("closed"), undefined, "a done row leaves the projection even while snoozed");

  // The active window keeps a pending timed snooze visible, then the just-woken row for one window.
  state.recordObservation(row("old-timed", "2026-07-07T10:00:00.000Z"));
  assert.equal(visible("old-timed"), undefined, "a quiet row outside the window is hidden");
  state.snoozeThread("old-timed", { kind: "until", until: "2026-07-10T09:00:00.000Z" });
  assert.equal(visible("old-timed")?.section, "snoozed", "a pending timed snooze stays visible outside the window");
  now = "2026-07-10T09:30:00.000Z";
  assert.deepEqual(
    { section: visible("old-timed")?.section, snooze: visible("old-timed")?.snooze },
    { section: "idle", snooze: null },
    "a row that woke by time stays visible inside the window after its wake",
  );
  now = "2026-07-11T09:00:01.000Z";
  assert.equal(visible("old-timed"), undefined, "one window after its wake the row ages out like any other");

  // Every held snooze stays visible, including a next-message one on an old row.
  state.recordObservation(row("old-next", "2026-07-01T10:00:00.000Z"));
  state.snoozeThread("old-next", { kind: "next-message" });
  now = "2026-07-20T10:00:00.000Z";
  assert.deepEqual(visible("old-next")?.snooze, { kind: "next-message" }, "a held next-message snooze never ages out");

  // Snooze and wake are idempotent owner writes, each published like a rename.
  await new Promise((resolve) => setImmediate(resolve));
  const before = events.length;
  assert.equal(state.snoozeThread("old-next", { kind: "next-message" }), "applied");
  assert.equal(state.snoozeThread("old-next", { kind: "until", until: "2026-07-21T09:00:00.000Z" }), "applied");
  assert.deepEqual(visible("old-next")?.snooze, { kind: "until", until: "2026-07-21T09:00:00.000Z" }, "a re-snooze overwrites");
  assert.equal(state.snoozeThread("old-next", null), "applied");
  assert.equal(state.snoozeThread("old-next", null), "applied", "waking an awake row is a no-op success");
  assert.equal(visible("old-next"), undefined, "a woken old row ages out of the window");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.slice(before).map((event) => event.kind === DomainEventKind.ThreadChanged && event.threadId),
    ["old-next", "old-next", "old-next", "old-next"],
    "every snooze write publishes a thread change",
  );
  assert.equal(state.snoozeThread("missing", { kind: "next-message" }), "missing");
  assert.equal(state.snoozeThread("quiet", { kind: "until", until: now }), "past", "a timed snooze must end in the future");
  state.close();

  // A thread with no message timestamp still holds a snooze: the watermark is '' rather than NULL.
  const db = new ThreadDb(join(dir, "no-message.db"), { now: () => now });
  db.appendModelDetails("no-message", { topic: "Untimed thread" });
  assert.equal(db.setSnooze("no-message", { kind: "next-message" }), true);
  assert.equal(db.listSessionState().find((item) => item.id === "no-message")?.section, "snoozed");
  db.close();

  // The snooze columns are added to an existing database, idempotently.
  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE threads DROP COLUMN snoozed_until; ALTER TABLE threads DROP COLUMN snoozed_through_message_at");
  legacy.close();
  const migrated = new State(path, clock);
  assert.equal(migrated.snoozeThread("quiet", { kind: "next-message" }), "applied");
  migrated.close();
  const reopened = new State(path, clock);
  assert.equal(reopened.listSessionState().find((item) => item.id === "quiet")?.section, "snoozed", "migration is idempotent and keeps the snooze");
  reopened.close();
  console.log("ok - snooze: read-time hold, timed and message wake, done wins, window rule, idempotent writes, migration");
} finally {
  cleanup();
}

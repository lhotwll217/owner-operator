import assert from "node:assert";
import { ScheduleKind, type ScheduleTrigger } from "@owner-operator/core";
import { computeNextRunAt, countMissedOccurrences } from "./schedule";

const now = Date.parse("2026-07-09T10:00:00.000Z");

const at: ScheduleTrigger = { kind: ScheduleKind.At, at: "2026-07-09T10:05:00.000Z" };
assert.equal(computeNextRunAt(at, now), "2026-07-09T10:05:00.000Z");
assert.equal(computeNextRunAt(at, now + 300_000), null, "one-shot does not repeat after its instant");

const every: ScheduleTrigger = { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: now - 30_000 };
assert.equal(computeNextRunAt(every, now), "2026-07-09T10:00:30.000Z", "interval advances from its stable anchor");
assert.equal(
  computeNextRunAt(every, now + 10 * 60_000),
  "2026-07-09T10:10:30.000Z",
  "missed interval occurrences collapse to the next future instant",
);

assert.equal(
  countMissedOccurrences(
    { kind: ScheduleKind.Cron, expression: "0 * * * * *", timeZone: "UTC" },
    Date.parse("2026-07-09T10:00:00.000Z"),
    Date.parse("2026-07-09T10:03:30.000Z"),
  ),
  3,
  "cron downtime records skipped occurrences without replaying them",
);

const cron: ScheduleTrigger = {
  kind: ScheduleKind.Cron,
  expression: "0 9 * * *",
  timeZone: "Europe/Helsinki",
};
assert.equal(computeNextRunAt(cron, now), "2026-07-10T06:00:00.000Z", "cron is evaluated in its stored IANA zone");

assert.equal(computeNextRunAt({ kind: ScheduleKind.NeedsYou }, now), null, "event triggers are never timer-due");
assert.throws(
  () => computeNextRunAt({ kind: ScheduleKind.Cron, expression: "bad", timeZone: "UTC" }, now),
  /invalid cron/i,
);

process.stdout.write("ok — scheduler calendar math\n");

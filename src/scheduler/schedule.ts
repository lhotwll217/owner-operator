import { Cron } from "croner";
import { ScheduleKind, type ScheduleTrigger } from "@owner-operator/core";

/** Return the next timer occurrence strictly after `nowMs`; event triggers return null. */
export function computeNextRunAt(trigger: ScheduleTrigger, nowMs: number): string | null {
  if (trigger.kind === ScheduleKind.NeedsYou) return null;

  if (trigger.kind === ScheduleKind.At) {
    const atMs = Date.parse(trigger.at);
    if (!Number.isFinite(atMs)) throw new Error("invalid at schedule: expected an ISO timestamp");
    return atMs > nowMs ? new Date(atMs).toISOString() : null;
  }

  if (trigger.kind === ScheduleKind.Every) {
    if (!Number.isSafeInteger(trigger.everyMs) || trigger.everyMs < 1_000) {
      throw new Error("invalid every schedule: everyMs must be an integer of at least 1000");
    }
    if (!Number.isSafeInteger(trigger.anchorMs) || trigger.anchorMs < 0) {
      throw new Error("invalid every schedule: anchorMs must be a non-negative integer");
    }
    if (nowMs < trigger.anchorMs) return new Date(trigger.anchorMs).toISOString();
    const steps = Math.floor((nowMs - trigger.anchorMs) / trigger.everyMs) + 1;
    return new Date(trigger.anchorMs + steps * trigger.everyMs).toISOString();
  }

  try {
    const cron = new Cron(trigger.expression, { timezone: trigger.timeZone, catch: false });
    const next = cron.nextRun(new Date(nowMs));
    return next ? next.toISOString() : null;
  } catch (error) {
    throw new Error(`invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Count recurring occurrences after the stored due time through startup/dispatch time. */
export function countMissedOccurrences(
  trigger: ScheduleTrigger,
  scheduledMs: number,
  nowMs: number,
): number {
  if (nowMs <= scheduledMs) return 0;
  if (trigger.kind === ScheduleKind.Every) {
    return Math.floor((nowMs - scheduledMs) / trigger.everyMs);
  }
  if (trigger.kind !== ScheduleKind.Cron) return 0;

  const cron = new Cron(trigger.expression, { timezone: trigger.timeZone, catch: false });
  let cursor = new Date(scheduledMs);
  let missed = 0;
  for (;;) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > nowMs) return missed;
    missed += 1;
    cursor = next;
  }
}

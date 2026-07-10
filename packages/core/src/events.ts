import type { ScheduleRunStatus } from "./scheduling";
import type { ThreadState } from "./status";

export enum DomainEventKind {
  ThreadChanged = "thread.changed",
  ScheduleChanged = "schedule.changed",
  ScheduleRunChanged = "schedule-run.changed",
}

export type DomainEvent =
  | {
      kind: DomainEventKind.ThreadChanged;
      threadId: string;
      state: ThreadState;
      lastMessageAt: string | null;
      needsEnrichment: boolean;
    }
  | { kind: DomainEventKind.ScheduleChanged; scheduleId: string }
  | { kind: DomainEventKind.ScheduleRunChanged; scheduleId: string; runId: string; status: ScheduleRunStatus };

export enum GatewayEventKind {
  StateChanged = "state.changed",
  ScheduleChanged = "schedule.changed",
  ScheduleRunChanged = "schedule-run.changed",
}

/** External events invalidate a projection; clients always refetch durable truth. */
export type GatewayEvent =
  | { kind: GatewayEventKind.StateChanged }
  | { kind: GatewayEventKind.ScheduleChanged }
  | { kind: GatewayEventKind.ScheduleRunChanged };

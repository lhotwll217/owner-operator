const REASON_FILLER = new Set(["a", "an", "is", "the"]);

export function requiredReasonTerms(reason: string): string[] {
  return [...new Set(reason.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((term) => !REASON_FILLER.has(term));
}

export interface DelegationTrajectoryEvent {
  phase: "start" | "end";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  succeeded?: boolean;
}

/** Return the exact details-call index that covers a launch, bounded to the current selection
 * attempt. A call for a different harness is not evidence for the launched harness. */
export function relevantDetailsCallIndex(
  events: DelegationTrajectoryEvent[],
  harness: string,
  afterExclusive: number,
  beforeExclusive: number,
): number {
  for (let index = beforeExclusive - 1; index > afterExclusive; index -= 1) {
    const event = events[index];
    if (event?.phase !== "end" || event.name !== "get_harness_details" || event.succeeded !== true) continue;
    const start = events.find((candidate) => candidate.phase === "start" && candidate.toolCallId === event.toolCallId);
    const harnesses = start?.args.harnesses;
    if (Array.isArray(harnesses) && harnesses.includes(harness)) return index;
  }
  return -1;
}

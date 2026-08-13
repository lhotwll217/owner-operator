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

/** Return the successful completion index of a paired call wholly inside an ordering boundary. */
export function successfulCallCompletionIndex(
  events: DelegationTrajectoryEvent[],
  matchesStart: (event: DelegationTrajectoryEvent) => boolean,
  afterExclusive: number,
  beforeExclusive: number,
): number {
  for (let endIndex = beforeExclusive - 1; endIndex > afterExclusive; endIndex -= 1) {
    const end = events[endIndex];
    if (end?.phase !== "end" || end.succeeded !== true) continue;
    const startIndex = events.findIndex((candidate, index) =>
      index > afterExclusive
      && index < endIndex
      && candidate.phase === "start"
      && candidate.toolCallId === end.toolCallId
      && matchesStart(candidate));
    if (startIndex >= 0) return endIndex;
  }
  return -1;
}

/** Return the exact details-call completion that covers a launch, bounded to the current selection
 * attempt. A call for a different harness is not evidence for the launched harness. */
export function relevantDetailsCallIndex(
  events: DelegationTrajectoryEvent[],
  harness: string,
  afterExclusive: number,
  beforeExclusive: number,
): number {
  return successfulCallCompletionIndex(events, (start) => {
    if (start.name !== "get_harness_details") return false;
    const harnesses = start.args.harnesses;
    return Array.isArray(harnesses) && harnesses.includes(harness);
  }, afterExclusive, beforeExclusive);
}

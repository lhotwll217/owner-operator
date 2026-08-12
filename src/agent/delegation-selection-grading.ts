const REASON_FILLER = new Set(["a", "an", "is", "the"]);

export function requiredReasonTerms(reason: string): string[] {
  return [...new Set(reason.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((term) => !REASON_FILLER.has(term));
}

export interface DelegationTrajectoryCall {
  name: string;
  args: Record<string, unknown>;
}

/** Return the exact details-call index that covers a launch, bounded to the current selection
 * attempt. A call for a different harness is not evidence for the launched harness. */
export function relevantDetailsCallIndex(
  calls: DelegationTrajectoryCall[],
  harness: string,
  afterExclusive: number,
  beforeExclusive: number,
): number {
  for (let index = beforeExclusive - 1; index > afterExclusive; index -= 1) {
    const call = calls[index];
    if (call?.name !== "get_harness_details") continue;
    const harnesses = call.args.harnesses;
    if (Array.isArray(harnesses) && harnesses.includes(harness)) return index;
  }
  return -1;
}

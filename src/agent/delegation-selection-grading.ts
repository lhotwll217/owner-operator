const REASON_FILLER = new Set(["a", "an", "is", "the"]);

export function requiredReasonTerms(reason: string): string[] {
  return [...new Set(reason.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((term) => !REASON_FILLER.has(term));
}

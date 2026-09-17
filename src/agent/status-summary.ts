export interface StatusSummaryShape {
  sentences: number;
  words: number;
}

export class InvalidStatusSummaryShapeError extends Error {}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

export function statusSummaryShape(summary: string): StatusSummaryShape {
  return {
    sentences: [...sentenceSegmenter.segment(summary)].filter(({ segment }) => /[\p{L}\p{N}]/u.test(segment)).length,
    words: [...wordSegmenter.segment(summary)].filter(({ isWordLike }) => isWordLike).length,
  };
}

export function assertStatusSummaryShape(summary: string): void {
  const { sentences } = statusSummaryShape(summary);
  if (sentences > 2) {
    throw new InvalidStatusSummaryShapeError(
      `invalid enrichment status summary: expected at most 2 sentences, received ${sentences}`,
    );
  }
}

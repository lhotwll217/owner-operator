import type { ScanRow } from "@owner-operator/core";

export interface ScannedTranscript extends Omit<ScanRow, "app" | "transcriptPath"> {
  ui: string;
  file: string;
  firstMessages: Array<{ role: string; text: string }>;
  recentMessages: Array<{ role: string; text: string }>;
  omittedMessageCount: number;
}

export interface ScanActiveTranscriptsResult {
  since: string;
  count: number;
  threads: ScannedTranscript[];
}

export function scanActiveTranscripts(
  args?: readonly string[],
  emit?: boolean,
): ScanActiveTranscriptsResult;

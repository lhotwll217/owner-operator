import type { ScanRow, TurnEnd } from "@owner-operator/core";
import type { Turn } from "../agent/needs-you";

export interface ScannedTranscript extends Omit<ScanRow, "app" | "transcriptPath"> {
  /** Load-bearing scanner/search namespace; monitor-to-State projection intentionally omits it. */
  namespace?: string;
  ui: string;
  file: string;
  turnEnd: TurnEnd | null;
  firstMessages: Array<{ role: string; text: string }>;
  recentMessages: Array<{ role: string; text: string }>;
  omittedMessageCount: number;
  classifierTurns?: Turn[];
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

export function buildGlobalResults(input: {
  record: any;
  cases: any[];
  observations?: any[];
  manifest?: any;
}): any;

export function buildStatsEntry(globalResults: any): any;

export function upsertStatsLog(file: string, entry: any): void;

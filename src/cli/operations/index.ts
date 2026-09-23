import type { OperationNoun } from "../oo-args";
import { runNoun, type Noun } from "./operation";
import { db } from "./db";
import { harness } from "./harness";
import { schedules } from "./schedules";
import { runSearch } from "./search";
import { sessionState } from "./session-state";

export const NOUNS: Partial<Record<OperationNoun, Noun>> = {
  "session-state": sessionState,
  schedules,
  db,
  harness,
};

export async function runOperation(noun: OperationNoun, argv: readonly string[]): Promise<number> {
  if (noun === "search") return runSearch(argv);
  const definition = NOUNS[noun];
  if (!definition) {
    process.stderr.write(`oo ${noun}: not available yet\n`);
    return 2;
  }
  return runNoun(noun, definition, argv);
}

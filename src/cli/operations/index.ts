import type { OperationNoun } from "../oo-args";
import { runNoun, type Noun } from "./operation";
import { db } from "./db";
import { schedules } from "./schedules";
import { sessionState } from "./session-state";

export const NOUNS: Partial<Record<OperationNoun, Noun>> = {
  "session-state": sessionState,
  schedules,
  db,
};

export async function runOperation(noun: OperationNoun, argv: readonly string[]): Promise<number> {
  const definition = NOUNS[noun];
  if (!definition) {
    process.stderr.write(`oo ${noun}: not available yet\n`);
    return 2;
  }
  return runNoun(noun, definition, argv);
}

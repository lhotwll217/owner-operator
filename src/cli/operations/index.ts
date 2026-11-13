import type { OperationNoun } from "../oo-args";
import { runNoun, type Noun } from "./operation";
import { db } from "./db";
import { harness } from "./harness";
import { schedules } from "./schedules";
import { runs } from "./runs";
import { runSearch } from "./search";
import { sessionState } from "./session-state";
import { skill } from "./skill";
import { worktrees } from "./worktrees";
import { hooks } from "./hooks";

export const NOUNS: Record<Exclude<OperationNoun, "search">, Noun> = {
  "session-state": sessionState,
  runs,
  schedules,
  db,
  harness,
  skill,
  worktrees,
  hooks,
};

export async function runOperation(noun: OperationNoun, argv: readonly string[]): Promise<number> {
  if (noun === "search") return runSearch(argv);
  return runNoun(noun, NOUNS[noun], argv);
}

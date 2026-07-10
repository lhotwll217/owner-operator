// Owner Operator — model-free session-state client projection. The gateway owns the read;
// this helper only adds stable row numbers for CLI/agent references.

import type { SessionStateRow } from "@owner-operator/core";
import { resolveBackend } from "./client";

export interface CurrentSessionStateRow extends SessionStateRow {
  index: number;
}

export async function getCurrentSessionStateRows(): Promise<CurrentSessionStateRow[]> {
  const backend = await resolveBackend();
  return (await backend.sessionState()).map((row, i) => ({ index: i + 1, ...row }));
}

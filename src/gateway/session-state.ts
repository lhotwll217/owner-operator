// Owner Operator — model-free session-state read. The gateway owns this projection in the
// shared DB; this module only adds stable row numbers for CLI/agent references.

import { resolveBackend } from "./client";
import type { SessionStateRow as DbSessionStateRow } from "./threads-db";

export interface CurrentSessionStateRow extends DbSessionStateRow {
  index: number;
}

export async function getCurrentSessionStateRows(): Promise<CurrentSessionStateRow[]> {
  const backend = await resolveBackend();
  return (await backend.loadSessionState()).map((row, i) => ({ index: i + 1, ...row }));
}

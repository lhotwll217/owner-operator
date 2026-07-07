// Gateway test helpers. Keep local to the gateway so its tests do not depend on agent/CLI code.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanRow } from "@owner-operator/core";

export function tempOoHome(prefix = "oo-test"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  process.env.OO_HOME = dir;
  return {
    dir,
    cleanup: () => {
      delete process.env.OO_HOME;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function fakeScanRow(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    id: "abc-123",
    source: "claude",
    repo: "owner-operator",
    app: "Claude CLI",
    topic: "daemon wiring",
    lastRole: "assistant",
    createdAt: "2026-06-09T10:00:00.000Z",
    lastMessageAt: "2026-06-09T10:05:00.000Z",
    secondsSinceLastMessage: 60,
    secondsSinceActivity: 60,
    working: false,
    ...overrides,
  };
}

export async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

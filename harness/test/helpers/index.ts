// Shared test helpers — the bits ≥2 colocated tests reach for. Keep this lean: promote a
// helper here only once a SECOND test needs it (same rule as fixtures; see docs/testing.md).
// Imported from a colocated test as `../test/helpers`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanRow } from "@owner-operator/core";

/**
 * A throwaway `$OO_HOME` for a test: a fresh tmp dir with the env wired, and a `cleanup` that
 * unsets the var and removes the dir. Call `cleanup()` in a `finally`.
 */
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

/** A scan row with sensible defaults (a needs-you Claude thread); override any field. */
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

/** Poll `cond` until it's true or `ms` elapses, then throw naming `what`. */
export async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

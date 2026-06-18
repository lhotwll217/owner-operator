// Unit test for owner settings: the shared window grammar (parseWindowMs / isWindowSpec) and
// the active-window loader (default, valid override, invalid value / invalid JSON fallback).
//   tsx src/settings.test.ts

import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWindowMs, isWindowSpec, loadActiveWindow, DEFAULT_ACTIVE_WINDOW } from "./settings.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-settings-"));
const NOW = 1_700_000_000_000; // fixed epoch ms — keeps the rolling-window math deterministic

try {
  // Rolling durations are relative to nowMs; "today" snaps to local midnight; ISO is absolute.
  assert.equal(parseWindowMs("24h", NOW), NOW - 24 * 3600000, "Nh → rolling hours");
  assert.equal(parseWindowMs("2d", NOW), NOW - 2 * 86400000, "Nd → rolling days");
  const today = parseWindowMs("today", NOW)!;
  assert.ok(today <= NOW && today > NOW - 86400000, "today → local midnight within the last day");
  assert.equal(parseWindowMs("2026-06-01", NOW), new Date("2026-06-01T00:00:00").getTime(), "ISO date → absolute midnight");
  assert.equal(parseWindowMs("nonsense", NOW), null, "unparseable → null");
  assert.equal(parseWindowMs("5", NOW), null, "bare number (no unit) → null");

  assert.ok(isWindowSpec("36h") && isWindowSpec("7d") && isWindowSpec("today"), "valid specs accepted");
  assert.ok(!isWindowSpec("soon") && !isWindowSpec(""), "typos rejected");

  // No config → default rolling day (the fix: not calendar-"today").
  assert.equal(loadActiveWindow(ooHome), DEFAULT_ACTIVE_WINDOW, "no config → default");
  assert.equal(DEFAULT_ACTIVE_WINDOW, "1d", "default is a rolling 24h, not calendar-today");

  // Valid override honored; invalid value and invalid JSON both fall back to the default.
  writeFileSync(join(ooHome, "settings.json"), JSON.stringify({ activeWindow: "36h" }));
  assert.equal(loadActiveWindow(ooHome), "36h", "valid override honored");
  writeFileSync(join(ooHome, "settings.json"), JSON.stringify({ activeWindow: "whenever" }));
  assert.equal(loadActiveWindow(ooHome), DEFAULT_ACTIVE_WINDOW, "invalid value → default");
  writeFileSync(join(ooHome, "settings.json"), "{ not json");
  assert.equal(loadActiveWindow(ooHome), DEFAULT_ACTIVE_WINDOW, "invalid JSON → default");

  process.stdout.write("ok — settings: window grammar (Nh/Nd/today/ISO), spec validation, active-window load + fallbacks\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

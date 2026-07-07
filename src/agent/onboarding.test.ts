// Flow-level test for the onboarding extension: walk the guided setup with a scripted UI standing
// in for a real user (no TTY, no model), and assert on what it writes and which branches it takes.
// Complements packages/core/src/onboarding.test.ts (the pure writers) by covering the flow itself.
//   tsx src/agent/onboarding.test.ts

import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSessionRoot, isOnboarded } from "@owner-operator/core";
import { runOnboarding } from "./onboarding";

// A scripted stand-in for ctx.ui: pops queued answers per dialog kind, records every prompt/notify.
function scriptedUi(answers: { confirm?: boolean[]; input?: (string | undefined)[]; select?: (string | undefined)[] }) {
  const notes: string[] = [];
  const q = { confirm: [...(answers.confirm ?? [])], input: [...(answers.input ?? [])], select: [...(answers.select ?? [])] };
  const ui = {
    confirm: async (t: string) => { notes.push(`confirm:${t}`); return q.confirm.shift() ?? false; },
    input: async (t: string) => { notes.push(`input:${t}`); return q.input.shift(); },
    select: async (t: string) => { notes.push(`select:${t}`); return q.select.shift(); },
    notify: (m: string) => { notes.push(`notify:${m}`); },
  };
  return { ui, notes };
}

const read = (home: string, f: string) => JSON.parse(readFileSync(join(home, f), "utf8"));

// --- happy path: proceed, set privacy + window, sources already detected ---
{
  const home = mkdtempSync(join(tmpdir(), "oo-flow-"));
  process.env.OO_HOME = home;
  try {
    // Seed a source so detection reports FOUND (the found branch must skip the manual-add prompt).
    const root = join(home, "claude");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "s.jsonl"), "{}\n");
    addSessionRoot(home, "claude", root);

    const { ui, notes } = scriptedUi({ confirm: [true], input: ["~/work/clientX, ~/personal"], select: ["36h"] });
    await runOnboarding({ hasUI: true, ui } as any);

    const bl = read(home, "blacklist.json");
    assert.deepEqual(bl.paths.map((p: string) => p.split("/").pop()).sort(), ["clientX", "personal"], "off-limits paths written (~ expanded)");
    assert.equal(read(home, "settings.json").activeWindow, "36h", "active window written");
    assert.equal(isOnboarded(home), true, "marker written → onboarded");
    assert.ok(notes.some((n) => n.startsWith("notify:Found sessions from:")), "detection surfaced sessions");
    assert.ok(!notes.some((n) => n.includes("Sessions elsewhere?")), "found → skipped manual-add");
    assert.ok(notes.some((n) => n.startsWith("notify:Set up.")), "reached the handoff");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- decline at the welcome gate: nothing is written, and it points at /onboarding ---
{
  const home = mkdtempSync(join(tmpdir(), "oo-flow-decline-"));
  process.env.OO_HOME = home;
  try {
    const { ui, notes } = scriptedUi({ confirm: [false] });
    await runOnboarding({ hasUI: true, ui } as any);
    assert.equal(existsSync(join(home, "blacklist.json")), false, "declined → no config written");
    assert.equal(isOnboarded(home), false, "declined → not marked onboarded");
    assert.ok(notes.some((n) => n.includes("/onboarding")), "points at re-running later");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- no UI (headless `oo "question"`): never blocks on a dialog, never writes ---
{
  const home = mkdtempSync(join(tmpdir(), "oo-flow-headless-"));
  process.env.OO_HOME = home;
  try {
    const { ui, notes } = scriptedUi({ confirm: [true] });
    await runOnboarding({ hasUI: false, ui } as any);
    assert.equal(notes.length, 0, "no UI → no prompts");
    assert.equal(isOnboarded(home), false, "no UI → nothing written");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

process.stdout.write("ok — onboarding flow: happy path writes, decline no-op, headless no-op\n");

// Onboarding smoke — run the guided flow against a throwaway OO_HOME seeded with fake sessions,
// with a scripted stand-in for the user, and print the transcript + every file it wrote. Lets you
// eyeball the flow end to end (copy, branching, writes) without a TTY, a model, or a Mac.
//   npm run onboard:smoke        (from the repo root)
// Not a *.test.ts, so the tier runner never sweeps it in — this is a hand-run sandbox, not CI.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSessionRoot } from "@owner-operator/core";
import { runOnboarding } from "./onboarding";

// Throwaway home + a couple of fake source roots so detection reports "found".
const home = mkdtempSync(join(tmpdir(), "oo-onboard-smoke-"));
process.env.OO_HOME = home;
for (const [source, files] of [["claude", 3], ["codex", 2]] as const) {
  const root = join(home, `fake-${source}`);
  mkdirSync(join(root, "proj"), { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(root, "proj", `s${i}.jsonl`), "{}\n");
  addSessionRoot(home, source, root);
}

// Scripted answers, in dialog order — tweak these to walk different branches.
const answers: Record<string, unknown[]> = {
  confirm: [true], //                         "Set up now?" → yes
  input: ["~/work/clientX, ~/personal"], //    off-limits paths
  select: ["36h"], //                          active window
};
const ui = {
  confirm: async (title: string) => { console.log(`  ? ${title}  → ${answers.confirm[0]}`); return answers.confirm.shift() as boolean; },
  input: async (title: string) => { const v = answers.input.shift(); console.log(`  ? ${title}  → ${JSON.stringify(v)}`); return v as string | undefined; },
  select: async (title: string) => { const v = answers.select.shift(); console.log(`  ? ${title}  → ${JSON.stringify(v)}`); return v as string | undefined; },
  notify: (m: string, lvl = "info") => console.log(`  » [${lvl}] ${m}`),
};

console.log(`\nOO_HOME = ${home}\n--- walking onboarding ---`);
await runOnboarding({ hasUI: true, ui } as never, { force: true });

console.log("\n--- files written ---");
for (const f of ["blacklist.json", "session_sources.json", "settings.json", "onboarded.json"]) {
  try { console.log(`${f}\n${readFileSync(join(home, f), "utf8").trimEnd()}`); }
  catch { console.log(`${f}: (not written)`); }
}

rmSync(home, { recursive: true, force: true });
console.log("\nok — sandbox cleaned up");

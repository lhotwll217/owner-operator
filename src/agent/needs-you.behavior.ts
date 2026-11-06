// Live Jev check of the Need You question: `tsx src/agent/needs-you.behavior.ts`.
import assert from "node:assert/strict";
import { AWAITING_THRESHOLD, NEEDS_YOU_THRESHOLD, scoreStoppedSession, type Turn } from "./needs-you";

const owner = (text: string): Turn => ({ role: "owner", text });
const agent = (text: string): Turn => ({ role: "agent", text });

// `awaiting` is false unless set. A case that sets it alone judges only the awaiting answer.
const cases: Array<{ name: string; needsYou?: boolean; awaiting?: boolean; turns: Turn[] }> = [
  { name: "completed cleanup", needsYou: false, turns: [owner("Clean up completed threads."), agent("I checked the evidence and marked 12 completed threads done. Uncertain threads remain visible. The cleanup is complete.")] },
  { name: "unresolved decision", needsYou: true, turns: [owner("Build the export."), agent("The data has conflicting retention requirements. Which retention policy should the export use? This choice is required before I can implement it.")] },
  { name: "stopped partway", needsYou: true, turns: [owner("Implement and verify the export."), agent("I have started reading the files.")] },
  { name: "done with an optional offer", needsYou: false, turns: [owner("Open the video."), agent("The video is open in your default player. If you'd rather scrub through it, Studio is still running.")] },
  { name: "own work left undone", needsYou: true, turns: [owner("Upgrade Pi and review the result."), agent("Pi is updated and the tests pass. Nothing committed. My diff review remains; live verification is still a gap.")] },
  { name: "draft ready for owner review", needsYou: true, turns: [owner("Write the skill and let me review it."), owner("Go ahead, five rules is fine."), agent("Keeping five. Writing it now."), agent("The skill is ready for you at http://127.0.0.1:5000/. It is a single SKILL.md with five rules and five steps. The file is uncommitted and hasn't been run on any case yet.")] },
  { name: "owner stopped the work", needsYou: false, turns: [owner("Research why teams leave Next.js and check the reasons against our code."), agent("I'm sending a research agent to collect the cited reasons, and I'll match them against the code myself."), owner("No, let's stop here."), agent("Stopped before anything ran. No research agent went out and no files changed. The notes folder has the goal and the findings as they stand now.")] },
  { name: "replacement completed", needsYou: false, turns: [owner("Fix and verify the app."), agent("The first agent failed. Choose an agent to resume."), owner("Use the replacement and complete it."), agent("The replacement fixed the app. The requested tests and browser verification passed. All requested work is complete.")] },
  { name: "waiting on its own sub-agent", awaiting: true, turns: [owner("Find where checkout computes tax and fix the rounding."), agent("I've sent an explorer agent through the checkout module to find every tax call site."), agent("Still waiting on the checkout explorer. I'll make the rounding fix once it reports back.")] },
  { name: "background run already finished", needsYou: false, turns: [owner("Run the full test suite in the background and fix anything that fails."), agent("The suite is running in the background."), agent("The background run finished: 412 tests pass, including the two I fixed. Nothing else is left.")] },
];
const wrong: string[] = [];
for (const test of cases) {
  const scores = await scoreStoppedSession({ turns: test.turns });
  console.log(JSON.stringify({ name: test.name, needsYou: test.needsYou, awaiting: test.awaiting ?? false, scores }));
  if (test.needsYou !== undefined && (scores.needsYou >= NEEDS_YOU_THRESHOLD) !== test.needsYou) wrong.push(`${test.name} needsYou: ${scores.needsYou}`);
  if ((scores.awaiting >= AWAITING_THRESHOLD) !== (test.awaiting ?? false)) wrong.push(`${test.name} awaiting: ${scores.awaiting}`);
}
assert.deepEqual(wrong, []);

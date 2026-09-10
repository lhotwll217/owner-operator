import assert from "node:assert/strict";
import { enrichThread } from "./enrichment";

const cases = [
  { name: "completed cleanup", state: "idle", sample: "Owner: Clean up completed threads. Assistant: I checked the evidence and marked 12 completed threads done. Uncertain threads remain visible. The cleanup is complete." },
  { name: "unresolved decision", state: "needs-you", sample: "Owner: Build the export. Assistant: The data has conflicting retention requirements. Which retention policy should the export use? This choice is required before I can implement it." },
  { name: "unknown partial work", state: "idle", sample: "Owner: Implement and verify the export. Assistant: I have started reading the files. The sample ends here and no completion or owner question is available." },
  { name: "generated persona turn", state: "idle", sample: "Task: Generate only the next utterance of a synthetic customer persona for an interview test. Assistant: I need an easier way to collect the reports from my team." },
  { name: "replacement completed", state: "idle", sample: "Owner: Fix and verify the app. Assistant: The first agent failed. Choose an agent to resume. Owner: Use the replacement and complete it. Assistant: The replacement fixed the app. The requested tests and browser verification passed. All requested work is complete." },
];
for (const test of cases) {
  const result = await enrichThread(test.sample);
  assert.equal(result.state, test.state, `${test.name}: ${JSON.stringify(result)}`);
  if (test.state !== "needs-you") assert.equal(result.nextSteps, "", test.name);
  console.log(JSON.stringify({ name: test.name, result }));
}

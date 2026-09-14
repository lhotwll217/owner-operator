import assert from "node:assert/strict";
import { parseDetails } from "./enrichment";

const details = { topic: "Export implementation", summary: "The export is implemented and tests passed.", priority: 2, attention: "idle" };
assert.deepEqual(parseDetails(JSON.stringify(details)), details);
assert.deepEqual(parseDetails(JSON.stringify({ ...details, attention: "needs-you", summary: "Choose the retention policy." })), {
  ...details, attention: "needs-you", summary: "Choose the retention policy.",
});
for (const attention of ["working", "done", ["idle"], undefined]) {
  assert.throws(() => parseDetails(JSON.stringify({ ...details, attention })), /attention/);
}
for (const field of ["topic", "summary"]) {
  for (const invalid of [undefined, "", "   ", 3]) {
    assert.throws(() => parseDetails(JSON.stringify({ ...details, [field]: invalid })), new RegExp(field));
  }
}
for (const priority of [undefined, "3", 0, 6, 2.5]) {
  assert.throws(() => parseDetails(JSON.stringify({ ...details, priority })), /priority/);
}
console.log("ok - required presentation and settled attention contract");

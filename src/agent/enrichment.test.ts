import assert from "node:assert/strict";
import { parseDetails } from "./enrichment";

const details = { topic: "Export implementation", summary: "The export is implemented and tests passed.", priority: 2, attention: "idle" };
const response = { topic: details.topic, summary: details.summary, priority: details.priority, ownerAction: null };
assert.deepEqual(parseDetails(JSON.stringify(response)), details);
assert.deepEqual(parseDetails(JSON.stringify({ ...response, ownerAction: "Choose the retention policy.", summary: "Choose the retention policy." })), {
  ...details, attention: "needs-you", summary: "Choose the retention policy.",
});
for (const ownerAction of ["", "   ", ["review"], 1, false, undefined]) {
  assert.throws(() => parseDetails(JSON.stringify({ ...response, ownerAction })), /ownerAction/);
}
for (const field of ["topic", "summary"]) {
  for (const invalid of [undefined, "", "   ", 3]) {
    assert.throws(() => parseDetails(JSON.stringify({ ...response, [field]: invalid })), new RegExp(field));
  }
}
for (const priority of [undefined, "3", 0, 6, 2.5]) {
  assert.throws(() => parseDetails(JSON.stringify({ ...response, priority })), /priority/);
}
for (const attention of ["needs-you", "working", "done"]) {
  assert.equal(parseDetails(JSON.stringify({ ...response, attention })).attention, "idle",
    "a model flag cannot create owner attention or lifecycle state without an owner action");
}
console.log("ok - required presentation and owner-action-derived settled attention contract");

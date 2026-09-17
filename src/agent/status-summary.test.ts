import assert from "node:assert/strict";
import { assertStatusSummaryShape, statusSummaryShape } from "./status-summary";

assert.deepEqual(
  statusSummaryShape("Artifact storage confirmed at `workspace/artifacts/`. Widget checks are in progress."),
  { sentences: 2, words: 11 },
);
assert.deepEqual(
  statusSummaryShape("ALIGNMENT.md updated; implementation remains pending."),
  { sentences: 1, words: 5 },
  "a dotted filename is not another sentence",
);
assert.throws(
  () => assertStatusSummaryShape("Storage confirmed. Widget checks started. Rendering remains unverified."),
  /at most 2 sentences, received 3/,
);

console.log("ok - status-summary shape counts human sentences and rejects a third");

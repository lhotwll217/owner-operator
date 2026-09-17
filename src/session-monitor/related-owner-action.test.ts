import assert from "node:assert/strict";
import { relatedOwnerActionQuery } from "./scan";

assert.equal(
  relatedOwnerActionQuery(
    "Merge PR #14.",
    "Review passed. [PR #14](https://github.com/lhotwll217/stitcher/pull/14) is ready to merge.",
  ),
  "lhotwll217/stitcher/pull/14",
);
assert.equal(
  relatedOwnerActionQuery(
    "Review PR #12.",
    "The adjacent work is https://github.com/lhotwll217/stitcher/pull/14.",
  ),
  "Review PR #12.",
  "an adjacent artifact must not replace the provisional action",
);
assert.equal(
  relatedOwnerActionQuery("Confirm the widget is visible.", "No external artifact."),
  "Confirm the widget is visible.",
);

console.log("ok - related owner-action search prefers the matching primary artifact identity");

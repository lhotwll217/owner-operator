import assert from "node:assert/strict";
import { ownerOperatorCustomTools } from "./index";

for (const tool of ownerOperatorCustomTools) {
  assert.equal(tool.renderCall, undefined, `${tool.name} carries no competing local call renderer`);
  assert.equal(tool.renderResult, undefined, `${tool.name} carries no competing local result renderer`);
}

process.stdout.write("ok — OO tools carry no local renderers before pi-tool-display decorates them\n");

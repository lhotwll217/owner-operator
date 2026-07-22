import assert from "node:assert/strict";
import { ownerOperatorCustomTools } from "./index";

for (const name of ["delegate_agent", "manage_agent_run"]) {
  const tool = ownerOperatorCustomTools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} remains registered`);
  assert.equal(tool.renderCall, undefined, `§5.1 ${name} has no Pi call renderer`);
  assert.equal(tool.renderResult, undefined, `§5.1 ${name} has no Pi result renderer`);
}

process.stdout.write("ok — delegated-run tools use semantic activity, never Pi renderers\n");

import assert from "node:assert";
import { isSessionBoilerplate } from "./session-text.mjs";

assert.equal(isSessionBoilerplate("<recommended_plugins>catalog</recommended_plugins>"), true);
assert.equal(isSessionBoilerplate("  <environment_context>cwd</environment_context>"), true);
assert.equal(isSessionBoilerplate("find the real customer context"), false);

process.stdout.write("ok — shared session boilerplate classification\n");

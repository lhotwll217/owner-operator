import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as activity from "@owner-operator/core/activity";

assert.equal(typeof activity.replayTurnTrace, "function", "the public activity subpath imports independently");
const packageJson = JSON.parse(readFileSync(join(process.cwd(), "packages/core/package.json"), "utf8"));
assert.equal(packageJson.exports["./activity"], "./src/activity.ts", "activity has a dedicated core subpath");

const source = readFileSync(join(process.cwd(), "packages/core/src/activity.ts"), "utf8");
assert.doesNotMatch(source, /^\s*import\s/m, "the core activity module has no runtime dependencies");
for (const forbidden of ["node:fs", "pi-coding-agent", "pi-tui", "src/shared", "src/cli", "src/agent"]) {
  assert.ok(!source.includes(forbidden), `browser-safe activity does not reference ${forbidden}`);
}

process.stdout.write("ok — browser-safe core activity subpath: standalone import, zero runtime dependencies\n");

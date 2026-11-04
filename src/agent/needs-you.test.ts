import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyNeedsYou, NEEDS_YOU_THRESHOLD, scoreNeedsYou, type Turn } from "./needs-you";

const dir = mkdtempSync(join(tmpdir(), "oo-needs-you-"));
const request = join(dir, "request.json");
const fakeJev = join(dir, "jev");
const respondWith = (body: string) => writeFileSync(fakeJev, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(${JSON.stringify(request)}, input);
  process.stdout.write(${JSON.stringify(body)});
});
`);
const previous = process.env.OO_JEV_BIN;
process.env.OO_JEV_BIN = fakeJev;
try {
  const turns: Turn[] = [
    { role: "owner", text: "Ship the export." },
    { role: "agent", text: "Export built. Should I push it?" },
  ];
  respondWith(JSON.stringify({ needs_you: { type: "noul", noul: NEEDS_YOU_THRESHOLD } }));
  chmodSync(fakeJev, 0o755);
  assert.equal(await classifyNeedsYou(turns), true, "a score at the threshold is Need You: a miss costs more than a false one");
  const sent = JSON.parse(readFileSync(request, "utf8"));
  assert.deepEqual(sent.state, { turns }, "the turns go to Jev whole, on stdin");
  assert.deepEqual(Object.keys(sent.questions), ["needs_you"], "one classification question");

  respondWith(JSON.stringify({ needs_you: { type: "noul", noul: NEEDS_YOU_THRESHOLD - 0.01 } }));
  assert.equal(await classifyNeedsYou(turns), false);

  respondWith(JSON.stringify({}));
  await assert.rejects(scoreNeedsYou(turns), /no needs_you score/, "a missing score fails the call instead of reading as Idle");
} finally {
  if (previous === undefined) delete process.env.OO_JEV_BIN; else process.env.OO_JEV_BIN = previous;
  rmSync(dir, { recursive: true, force: true });
}

console.log("ok - needs-you sends the turns to Jev and applies the recall-first threshold");

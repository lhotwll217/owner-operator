import assert from "node:assert/strict";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { classifyNeedsYou, NEEDS_YOU_THRESHOLD, scoreNeedsYou, type Turn } from "./needs-you";

const turns: Turn[] = [
  { role: "owner", text: "Ship the export." },
  { role: "agent", text: "Export built. Should I push it?" },
];
const requests: Array<{ url: string; body: { state: unknown; questions: Record<string, unknown> } }> = [];
const jev = (status: number, body: unknown) => new TypeSafeClient({
  apiKey: "test-key",
  compression: false,
  logLevel: "off",
  retry: { maxRetries: 0 },
  fetch: async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  },
});
const scored = (noul: number) => jev(200, { model: "jev-test", answers: { needs_you: { type: "noul", noul } } });

assert.equal(await scoreNeedsYou(turns, scored(0.73)), 0.73);
assert.equal(requests[0].url, "https://api.typesafe.ai/v1/systemone");
assert.deepEqual(requests[0].body.state, { turns }, "the turns go to Jev whole");
assert.deepEqual(Object.keys(requests[0].body.questions), ["needs_you"], "one classification question");

assert.equal(await classifyNeedsYou(turns, scored(NEEDS_YOU_THRESHOLD)), true, "a score at the threshold is Need You: a miss costs more than a false one");
assert.equal(await classifyNeedsYou(turns, scored(NEEDS_YOU_THRESHOLD - 0.01)), false);
await assert.rejects(classifyNeedsYou(turns, jev(401, { error: "bad key" })), "a rejected call fails instead of reading as Idle");

console.log("ok - needs-you posts the turns to Jev's System One API and returns its score");

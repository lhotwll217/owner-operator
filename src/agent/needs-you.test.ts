import assert from "node:assert/strict";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { AWAITING_THRESHOLD, classifyStoppedSession, NEEDS_YOU_THRESHOLD, scoreStoppedSession, type Turn } from "./needs-you";

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
const scored = (needsYou: number, awaiting = 0) => jev(200, { model: "jev-test", answers: {
  needs_you: { type: "noul", noul: needsYou }, awaiting: { type: "noul", noul: awaiting },
} });

assert.deepEqual(await scoreStoppedSession({ turns }, scored(0.73, 0.2)), { needsYou: 0.73, awaiting: 0.2 });
assert.equal(requests[0].url, "https://api.typesafe.ai/v1/systemone");
assert.deepEqual(requests[0].body.state, { turns }, "the turns go to Jev whole");
assert.deepEqual(Object.keys(requests[0].body.questions), ["needs_you", "awaiting"], "both questions share one call");

await scoreStoppedSession({ turns, statusSummaries: ["Draft ready for review.", "Draft underway.", "Draft underway.", "Rules agreed.", "Task set."] }, scored(0.5));
assert.deepEqual(requests[1].body.state, { statusSummaries: ["Rules agreed.", "Draft underway.", "Draft ready for review."], turns }, "the three latest distinct summaries go first, oldest first");

assert.equal((await classifyStoppedSession({ turns }, scored(NEEDS_YOU_THRESHOLD))).needsYou, true, "a score at the threshold is Need You: a miss costs more than a false one");
assert.equal((await classifyStoppedSession({ turns }, scored(NEEDS_YOU_THRESHOLD - 0.01))).needsYou, false);
assert.equal((await classifyStoppedSession({ turns }, scored(0.9, AWAITING_THRESHOLD))).awaiting, true, "a score at the threshold is awaiting its own work");
assert.equal((await classifyStoppedSession({ turns }, scored(0.9, AWAITING_THRESHOLD - 0.01))).awaiting, false);
await assert.rejects(classifyStoppedSession({ turns }, jev(401, { error: "bad key" })), "a rejected call fails instead of reading as Idle");

console.log("ok - needs-you posts the turns to Jev's System One API and returns both scores");

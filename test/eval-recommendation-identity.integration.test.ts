import assert from "node:assert";
import recommendationIdentity from "../eval/asserts/recommendation-identity.mjs";

const ids = [
  "fx-aurora-flaky-4b21",
  "fx-nova-queue-codex-b222",
  "fx-cipher-injection-c333",
];
const context = {
  test: {
    metadata: {
      recommendationIds: ids,
      stateRelevantIds: ["fx-aurora-flaky-4b21"],
      priorityRelevantIds: [],
    },
  },
};
const valid = [
  "1. **aurora-weather · Claude CLI · Flaky forecast cache test** — Review and merge PR #42. (Needs you.)",
  "2. **nova-events · Codex CLI · Event backbone decision** — Approve the NATS JetStream implementation plan.",
  "3. **cipher-auth · Codex CLI · Signing-key rotation** — Review PR #90.",
].join("\n");

assert.equal(recommendationIdentity(valid, context).pass, true);

for (const [field, invalid] of [
  ["repo", valid.replace("nova-events · ", "")],
  ["app", valid.replace("nova-events · Codex CLI", "nova-events")],
  ["exact topic", valid.replace("Event backbone decision", "Queue choice")],
  ["nextSteps action", valid.replace("Approve the NATS JetStream implementation plan", "Approve the plan")],
]) {
  assert.equal(recommendationIdentity(invalid, context).pass, false, `every task requires its ${field}`);
}

const crossWiredAction = valid
  .replace("Review and merge PR #42", "__cipher_action__")
  .replace("Review PR #90", "Review and merge PR #42")
  .replace("__cipher_action__", "Review PR #90");
assert.equal(recommendationIdentity(crossWiredAction, context).pass, false, "fields cannot be mixed across rows");

const duplicate = valid.replace(
  "cipher-auth · Codex CLI · Signing-key rotation** — Review PR #90",
  "nova-events · Codex CLI · Event backbone decision** — Approve the NATS JetStream implementation plan",
);
assert.equal(recommendationIdentity(duplicate, context).pass, false, "each required row appears exactly once");

assert.equal(
  recommendationIdentity(valid.replace("Review PR #90", "Review PR #90. (Idle.)"), context).pass,
  false,
  "state appears only when it affects the recommendation",
);
assert.equal(
  recommendationIdentity(valid.replace("Event backbone decision", "Event backbone decision · P4"), context).pass,
  false,
  "priority appears only when it affects the recommendation",
);

assert.equal(
  recommendationIdentity("First priority — Review and merge PR #42.", context).pass,
  false,
  "generic headings do not map to fixture rows",
);

process.stdout.write("ok — recommendation identity maps every task to one synthetic widget row\n");

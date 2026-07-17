import assert from "node:assert";
import type { CurrentSessionStateRow } from "../../gateway/session-state";
import { currentSessionStateResult, filterCurrentSessionStateRows } from "./session-state";

const row = (id: string, repo: string, topic: string, state: CurrentSessionStateRow["state"]): CurrentSessionStateRow => ({
  index: Number(id),
  id,
  source: "codex",
  repo,
  app: "Codex App",
  topic,
  generatedTopic: topic,
  ownerTitle: null,
  summary: null,
  nextSteps: null,
  priority: null,
  state,
  stateReason: null,
  stateSince: "2026-07-10T00:00:00.000Z",
  lastActiveAt: "2026-07-10T00:00:00.000Z",
  createdAt: "2026-07-10T00:00:00.000Z",
  lastMessageAt: "2026-07-10T00:00:00.000Z",
  diffAdded: null,
  diffDeleted: null,
  parentThreadId: null,
  lastActive: "now",
});

const rows = [
  row("1", "Amplify", "Billing summary", "idle"),
  row("2", "Amplify", "Billing summary follow-up", "idle"),
  row("3", "owner-operator", "Billing summary", "needs-you"),
];

assert.deepEqual(filterCurrentSessionStateRows(rows, { state: "needs-you" }).map(({ id }) => id), ["3"]);
assert.deepEqual(filterCurrentSessionStateRows(rows, { ids: ["2", " 1 ", "2"] }).map(({ id }) => id), ["1", "2"]);
assert.deepEqual(filterCurrentSessionStateRows(rows, { state: "idle", ids: ["2", "3"] }).map(({ id }) => id), ["2"]);

const empty = currentSessionStateResult(rows, { state: "working", ids: ["missing-id"] }, "2026-07-10T12:00:00.000Z");
assert.deepEqual(empty, {
  scope: "current-widget-projection",
  authoritative: true,
  readAt: "2026-07-10T12:00:00.000Z",
  filters: { state: "working", ids: ["missing-id"] },
  totalRows: 3,
  matchedRows: 0,
  evidenceBoundary: {
    kind: "summary-index",
    transcriptEvidence: false,
    next: "Use each thread id with session-search when the question asks what changed, why, proof, exact artifacts, or other transcript details.",
  },
  missingIds: ["missing-id"],
  stateFilteredIds: [],
  threads: [],
});

const stateMismatch = currentSessionStateResult(rows, { state: "working", ids: ["1"] }, "2026-07-10T12:00:00.000Z");
assert.deepEqual(stateMismatch.missingIds, [], "an id present in the widget is not mislabeled missing");
assert.deepEqual(stateMismatch.stateFilteredIds, ["1"], "an exact id excluded by state is reported separately");

process.stdout.write("ok — current session state exact filters and authoritative result metadata\n");

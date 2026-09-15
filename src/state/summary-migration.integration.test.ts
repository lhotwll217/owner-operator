import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { State } from "./state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";

const { dir, cleanup } = tempOoHome("oo-summary-migration");
const path = join(dir, "state.db");
const options = { now: () => "2026-06-09T12:00:00.000Z" };
try {
  const seed = new State(path, options);
  const row = fakeScanRow();
  seed.recordObservation(row);
  seed.appendEnrichment(row.id, { topic: "Generated export title", summary: "Export implemented.", priority: 3, attention: "idle" }, row.lastMessageAt);
  seed.renameThread(row.id, "Owner pinned export");
  seed.recordObservation({ ...row, id: "done" });
  seed.markThreadsDone(["done"]);
  seed.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE thread_details ADD COLUMN next_steps TEXT; ALTER TABLE thread_details ADD COLUMN state_reason TEXT; ALTER TABLE threads DROP COLUMN enriched_while_working");
  legacy.exec("UPDATE thread_details SET next_steps = 'Obsolete review instruction', state_reason = 'Legacy state explanation'");
  const history = legacy.prepare("SELECT thread_id, version, created_at, written_by, state, priority, topic, summary FROM thread_details ORDER BY thread_id, version").all();
  legacy.close();

  const migrated = new State(path, options);
  assert.equal(migrated.listCurrentSessionState()[0].topic, "Owner pinned export");
  assert.deepEqual(migrated.listEnrichmentCandidates().map(({ id }) => id), [row.id]);
  assert.ok(!migrated.listSessionState().some(({ id }) => id === "done"));
  migrated.close();
  const check = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(check.prepare("SELECT thread_id, version, created_at, written_by, state, priority, topic, summary FROM thread_details ORDER BY thread_id, version").all(), history, "migration preserves retained history exactly");
  const columns = check.prepare("PRAGMA table_info(thread_details)").all().map(({ name }) => name);
  assert.ok(!columns.includes("next_steps") && !columns.includes("state_reason"));
  check.close();

  const reopened = new State(path, options);
  assert.equal(reopened.appendEnrichment(row.id, { topic: "Updated export title", summary: "Export verified.", priority: 2, attention: "idle" }, row.lastMessageAt), true);
  reopened.close();
  const again = new State(path, options);
  assert.deepEqual(again.listEnrichmentCandidates(), [], "idempotent migration retains successful new-contract enrichment");
  assert.equal(again.listCurrentSessionState()[0].summary, "Export verified.");
  again.close();
  console.log("ok - legacy columns removed atomically; history, pinned title, Done, re-enrichment, and restart preserved");
} finally {
  cleanup();
}

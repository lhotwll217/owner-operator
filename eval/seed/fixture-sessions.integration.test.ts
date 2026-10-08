import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadDb } from "../../src/state/database.ts";
import { SESSIONS, OWNER_OPERATOR_SESSIONS } from "../fixtures/sessions.mjs";
import { seedFixtureSessions } from "./fixture-sessions.mjs";

const root = mkdtempSync(join(tmpdir(), "oo-fixture-seed-"));
const ooHome = join(root, "home");
mkdirSync(ooHome);
const policy = '{"paths":["credential-path"],"repos":[]}';
writeFileSync(join(ooHome, "blacklist.json"), policy);
const existingConnection = new ThreadDb(join(ooHome, "state.db"));
try {
  const now = Date.UTC(2026, 0, 2, 12);
  const seeded = seedFixtureSessions({ root, ooHome, now });
  assert.equal(readFileSync(join(ooHome, "blacklist.json"), "utf8"), policy);
  const rows = existingConnection.listSessionState();
  assert.equal(rows.length, SESSIONS.length);
  for (const fixture of SESSIONS) {
    const row = rows.find((candidate) => candidate.id === fixture.id)!;
    assert.equal(row.state, fixture.state);
    assert.equal(row.lastMessageAt, new Date(now - Math.min(...fixture.messages.map((message) => message.offsetMin)) * 60_000).toISOString());
    const transcript = readFileSync(seeded.transcriptPaths.get(fixture.id)!, "utf8");
    assert.ok(transcript.includes(fixture.id));
  }
  for (const fixture of OWNER_OPERATOR_SESSIONS) {
    const transcript = readFileSync(join(ooHome, "sessions", `${fixture.id}.jsonl`), "utf8");
    assert.equal(JSON.parse(transcript.split("\n")[0]).id, fixture.id);
  }
  assert.deepEqual(seeded.sessionSources.add.map(({ source }) => source), ["claude", "codex"]);
} finally {
  existingConnection.close();
  rmSync(root, { recursive: true, force: true });
}
console.log("fixture seeding preserves policy and is visible to existing connections");

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { markOnboarded } from "@owner-operator/core";
import { State } from "../state/state";
import { SessionMonitor } from "./monitor";
import { tempOoHome } from "../gateway/test/helpers";

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "oo-census-"));
process.env.HOME = home;
const { dir, cleanup } = tempOoHome("oo-reconciliation");
markOnboarded(dir, { via: "test" });
const state = new State(join(dir, "state.db"));
const monitor = new SessionMonitor(state);
const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
const project = join(home, "project");
function transcript(file: string, records: unknown[]) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  utimesSync(file, new Date(at), new Date(at));
}
try {
  for (let i = 0; i < 55; i++) {
    transcript(join(home, ".codex", "sessions", `real-${i}.jsonl`), [
      { type: "session_meta", payload: { id: `real-${i}`, cwd: project, source: "cli" } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ text: "Investigate the unresolved bug" }] } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", content: [{ text: "Which behavior should the feature preserve?" }] } },
    ]);
  }
  const old = new Date(Date.now() - 5 * 86_400_000);
  const oldFile = join(home, ".codex", "sessions", "old.jsonl");
  transcript(oldFile, [
    { type: "session_meta", payload: { id: "old", cwd: project, source: "cli" } },
    { type: "response_item", timestamp: old.toISOString(), payload: { type: "message", role: "user", content: [{ text: "Old quiet work" }] } },
  ]);
  utimesSync(oldFile, old, old);
  transcript(join(home, ".codex", "sessions", "guardian.jsonl"), [
    { type: "session_meta", payload: { id: "guardian", cwd: project, source: { subagent: { other: "guardian" } } } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ text: "Assess this command" }] } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", content: [{ text: '{"outcome":"allow"}' }] } },
  ]);
  const rows = await monitor.poll();
  assert.equal(rows.length, 55, "the default monitor updates every candidate within the configured window beyond the old 50-row cap");
  assert.ok(!rows.some((row) => row.id === "old"), "the configured scan window excludes old quiet history");
  assert.ok(!state.listSessionState().some((row) => row.id === "old"), "old history is not ingested behind the widget filter");
  assert.ok(!rows.some((row) => row.id === "guardian"), "explicit guardian provenance is not independent owner work");
  assert.equal(state.listEnrichmentCandidates().length, 55, "visible idle rows remain eligible for their first successful enrichment");
  transcript(join(home, ".claude", "projects", "demo", "first-message.jsonl"), [
    { type: "user", entrypoint: "cli", sessionId: "first-message", cwd: project, timestamp: at, message: { content: "Implement the export" } },
  ]);
  const firstMessageRows = await monitor.poll();
  assert.ok(firstMessageRows.some((row) => row.id === "first-message" && row.topic && row.summary), "a one-off CLI session is visible from its first message");
  console.log("ok - configured scan window preserved; all 55 current rows eligible for updates");
} finally {
  monitor.stop();
  state.close();
  cleanup();
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

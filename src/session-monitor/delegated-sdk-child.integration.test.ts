// Integration: a delegated run's child session is indexed even when its harness runs through
// the Claude Agent SDK. The scan marks every SDK transcript automated, which keeps unrelated SDK
// workers out of the Inbox, but a child the run ledger names is a session the owner asked for.
// Real scanner over a temp $HOME, no model.
//   npm run test:integration   (from the repo root)

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, markOnboarded } from "@owner-operator/core";
import { tempOoHome } from "../gateway/test/helpers";

const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "oo-delegated-sdk-child-home-"));
process.env.HOME = home;
const { dir, cleanup } = tempOoHome("oo-delegated-sdk-child");
markOnboarded(dir, { via: "test" });

const childId = "3e89a7b7-7f80-4ef7-a330-3042aeb56828";
const workerId = "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const cwd = join(home, "dev", "demo-repo");
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const sdkTranscript = (sessionId: string, prompt: string, reply: string) =>
  [
    { type: "user", content: prompt, ts: at(10) },
    { type: "assistant", content: reply, ts: at(8) },
  ].map(({ type, content, ts }) => JSON.stringify({
    type, sessionId, cwd, entrypoint: "sdk-ts", timestamp: ts,
    message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) },
  }) + "\n").join("");

const projectDir = join(home, ".claude", "projects", "demo");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, `${childId}.jsonl`), sdkTranscript(childId, "Audit the billing webhook retries", "Retries are capped at three."));
writeFileSync(join(projectDir, `${workerId}.jsonl`), sdkTranscript(workerId, "Summarize this diff", "One file changed."));

try {
  const { State } = await import("../state/state");
  const { SessionMonitor } = await import("./monitor");
  const state = new State(join(dir, "state.db"));
  state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "Audit the billing webhook retries",
    cwd,
    origin: "grok-bot",
    depth: 1,
    timeoutSeconds: 3_600,
    childSessionId: childId,
  });

  const monitor = new SessionMonitor(state, { since: "7d" });
  const current = await monitor.poll();
  const enrichable = state.listEnrichmentCandidates().map((candidate) => candidate.id);
  monitor.stop();
  state.close();

  const { runQuery } = await import("../state/query");
  const threads = runQuery("SELECT id, app, raw_topic AS topic FROM threads", join(dir, "state.db")).rows;
  const child = threads.find((row) => row.id === childId);
  assert.ok(child, "the delegated SDK child has a threads row");
  assert.equal(child.app, "Claude SDK", "the child keeps its Claude host attribution");
  assert.ok(String(child.topic).includes("billing webhook"), "the child's topic comes from its transcript");
  assert.ok(enrichable.includes(childId), "the child is queued for title and summary enrichment");
  assert.equal(threads.find((row) => row.id === workerId), undefined, "an SDK worker no run names has no threads row");
  assert.equal(current.find((row) => row.id === workerId), undefined, "an SDK worker no run names stays hidden");

  process.stdout.write("ok — delegated SDK child indexed, unrelated SDK worker hidden\n");
} finally {
  cleanup();
  rmSync(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
}

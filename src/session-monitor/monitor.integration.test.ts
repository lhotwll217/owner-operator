import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markOnboarded, saveSessionRoots } from "@owner-operator/core";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { SessionMonitor } from "./monitor";

const { dir, cleanup } = tempOoHome("oo-session-monitor");
const state = new State(join(dir, "state.db"));

let finishEnrichment!: (details: { topic: string; nextSteps: string }) => void;
const enrichment = new Promise<{ topic: string; nextSteps: string }>((resolve) => { finishEnrichment = resolve; });
const monitor = new SessionMonitor(state, {
  scan: async () => [fakeScanRow()],
  enrich: async () => await enrichment,
});

try {
  const rows = await monitor.poll();
  assert.equal(rows[0].state, "needs-you", "scan is reconciled through state");
  assert.equal(rows[0].summary, null, "poll hot path does not await model enrichment");

  finishEnrichment({ topic: "Daemon foundation", nextSteps: "Review the state seam" });
  await waitFor(
    () => state.listSessionState()[0]?.nextSteps === "Review the state seam",
    1_000,
    "asynchronous enrichment",
  );
  assert.deepEqual(state.listEnrichmentCandidates(), [], "worker advances the enrichment watermark");

  const watchedRoot = join(dir, "sessions");
  mkdirSync(watchedRoot, { recursive: true });
  saveSessionRoots(dir, [{ source: "claude", root: watchedRoot }]);
  let watcherScanCalls = 0;
  const watcherMonitor = new SessionMonitor(state, {
    debounceMs: 10,
    scan: async () => {
      watcherScanCalls += 1;
      return [];
    },
  });
  watcherMonitor.watch();
  markOnboarded(dir, { via: "test" });
  await watcherMonitor.poll();
  writeFileSync(join(watchedRoot, "new-session.jsonl"), "{}\n");
  await waitFor(() => watcherScanCalls > 1, 1_000, "watcher to arm after onboarding");
  watcherMonitor.stop();

  let gatedEnrichmentCalls = 0;
  const gatedMonitor = new SessionMonitor(state, {
    scan: async () => [fakeScanRow({ lastMessageAt: "2026-06-09T10:05:00.000Z" })],
    enrich: async () => {
      gatedEnrichmentCalls += 1;
      return { topic: "should not run", nextSteps: "should not run" };
    },
    canEnrich: () => false,
  });
  await gatedMonitor.poll();
  await new Promise((resolve) => setTimeout(resolve, 20));
  gatedMonitor.stop();
  assert.equal(gatedEnrichmentCalls, 0, "setup gate prevents model enrichment before consent");

  const backgroundErrors: string[] = [];
  const failingMonitor = new SessionMonitor(state, {
    intervalMs: 10,
    scan: async () => { throw new Error("temporary scan failure"); },
    logger: (record) => { backgroundErrors.push(record.error); },
  });
  failingMonitor.start();
  await waitFor(() => backgroundErrors.length > 0, 1_000, "contained background poll error");
  failingMonitor.stop();
  assert.match(backgroundErrors[0], /temporary scan failure/, "background poll errors reach the monitor logger");

  const enrichmentErrors: string[] = [];
  const failingEnrichmentMonitor = new SessionMonitor(state, {
    scan: async () => [fakeScanRow({ lastMessageAt: "2026-06-09T10:06:00.000Z" })],
    enrich: async () => { throw new Error("temporary enrichment failure"); },
    logger: (record) => {
      if (String(record.event) === "enrichment-failed") enrichmentErrors.push(record.error);
    },
  });
  await failingEnrichmentMonitor.poll();
  await waitFor(() => enrichmentErrors.length > 0, 1_000, "contained enrichment error");
  failingEnrichmentMonitor.stop();
  assert.match(enrichmentErrors[0], /temporary enrichment failure/, "enrichment errors reach the monitor logger");

  process.stdout.write("ok — public session-monitor seam\n");
} finally {
  monitor.stop();
  state.close();
  cleanup();
}

import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_SESSION_SOURCES, markOnboarded, saveSessionRoots, type ThreadEnrichment } from "@owner-operator/core";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { SessionMonitor } from "./monitor";

const { dir, cleanup } = tempOoHome("oo-session-monitor");
const state = new State(join(dir, "state.db"));

let finishEnrichment!: (details: ThreadEnrichment) => void;
const enrichment = new Promise<ThreadEnrichment>((resolve) => { finishEnrichment = resolve; });
// A scan sees a yielded turn, never an owner obligation, so the reconciled row is idle until
// enrichment reads the conversation.
const scanned = fakeScanRow({ lastMessageAt: new Date().toISOString() });
const monitor = new SessionMonitor(state, {
  scan: async () => [scanned],
  enrich: async () => await enrichment,
});

try {
  const rows = await monitor.poll();
  assert.equal(rows[0].state, "idle", "scan is reconciled through state");
  assert.equal(rows[0].topic, scanned.topic, "a title shows from the first observation");
  assert.equal(rows[0].summary, null, "no recap is invented before one is generated");

  finishEnrichment({ topic: "Daemon foundation", summary: "Review the state seam", priority: 2, attention: "needs-you" as const });
  await waitFor(
    () => state.listSessionState()[0]?.summary === "Review the state seam",
    1_000,
    "asynchronous enrichment",
  );
  assert.deepEqual(state.listEnrichmentCandidates(), [], "worker advances the enrichment watermark");

  const watchedRoot = join(dir, "sessions");
  mkdirSync(watchedRoot, { recursive: true });
  saveSessionRoots(dir, [{ source: "claude", root: watchedRoot }]);
  let watcherScanCalls = 0;
  const scannedFiles: string[][] = [];
  const watcherMonitor = new SessionMonitor(state, {
    debounceMs: 10,
    scan: async (_since, _limit, files = []) => {
      watcherScanCalls += 1;
      scannedFiles.push([...files]);
      return [];
    },
  });
  watcherMonitor.watch();
  markOnboarded(dir, { via: "test" });
  await watcherMonitor.poll();
  const changed = join(watchedRoot, "new-session.jsonl");
  writeFileSync(changed, "{}\n");
  await waitFor(() => watcherScanCalls > 1, 1_000, "watcher to arm after onboarding");
  assert.deepEqual(scannedFiles[0], [], "the first poll scans every store");
  assert.deepEqual(scannedFiles[1], [changed], "a watched change scans only the file that changed");
  watcherMonitor.stop();

  let inFlight = 0;
  let peakInFlight = 0;
  const parallel = new SessionMonitor(state, {
    scan: async () => Array.from({ length: 6 }, (_, i) => fakeScanRow({ id: `parallel-${i}`, lastMessageAt: new Date().toISOString() })),
    enrich: async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return { topic: "Parallel", summary: "Enriched.", priority: 3, attention: "idle" as const };
    },
    enrichConcurrency: 4,
  });
  await parallel.poll();
  await waitFor(() => state.listSessionState().filter((row) => row.id.startsWith("parallel-") && row.summary === "Enriched.").length === 6, 1_000, "parallel enrichment");
  parallel.stop();
  assert.equal(peakInFlight, 4, "enrichment runs several threads at once, bounded by enrichConcurrency");

  const productRoot = join(dir, "sessions");
  mkdirSync(productRoot, { recursive: true });
  saveSessionRoots(dir, []);
  writeFileSync(join(dir, "session_sources.json"), JSON.stringify({ disable: KNOWN_SESSION_SOURCES }));
  let productWatcherScanCalls = 0;
  const productWatcherMonitor = new SessionMonitor(state, {
    debounceMs: 10,
    scan: async () => {
      productWatcherScanCalls += 1;
      return [];
    },
  });
  productWatcherMonitor.watch();
  await productWatcherMonitor.poll();
  writeFileSync(join(productRoot, "owner-session.jsonl"), "{}\n");
  await waitFor(() => productWatcherScanCalls > 1, 1_000, "product-owned OO watcher");
  productWatcherMonitor.stop();

  let gatedEnrichmentCalls = 0;
  const gatedMonitor = new SessionMonitor(state, {
    scan: async () => [fakeScanRow({ lastMessageAt: "2026-06-09T10:05:00.000Z" })],
    enrich: async () => {
      gatedEnrichmentCalls += 1;
      return { topic: "should not run", summary: "should not run", priority: 2, attention: "needs-you" as const };
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
    scan: async () => [fakeScanRow({ lastMessageAt: new Date().toISOString() })],
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

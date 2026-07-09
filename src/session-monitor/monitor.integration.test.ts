import assert from "node:assert";
import { join } from "node:path";
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

  process.stdout.write("ok — public session-monitor seam\n");
} finally {
  monitor.stop();
  state.close();
  cleanup();
}

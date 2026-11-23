import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { markOnboarded, saveSessionRoots } from "@owner-operator/core";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { SessionMonitor } from "./monitor";

// FSEvents can drop events, and libuv discards the dropped-event notice, so a watched store can
// change without any callback. A turn that ended unseen must still leave Working.
const { dir, cleanup } = tempOoHome("oo-missed-change");
const state = new State(join(dir, "state.db"));
const root = join(dir, "sessions");
mkdirSync(root, { recursive: true });
saveSessionRoots(dir, [{ source: "codex", root }]);
markOnboarded(dir, { via: "test" });

const transcriptPath = join(root, "rollout-session.jsonl");
const started = new Date().toISOString();
let turnEnded = false;
const scannedFiles: string[][] = [];
const monitor = new SessionMonitor(state, {
  intervalMs: 20,
  scan: async (_since, _limit, files = []) => {
    scannedFiles.push([...files]);
    return [fakeScanRow({
      id: "codex-session", source: "codex", transcriptPath, lastMessageAt: started,
      lastRole: turnEnded ? "assistant" : "user", working: !turnEnded,
    })];
  },
});

try {
  monitor.watch();
  monitor.start();
  await waitFor(() => state.listSessionState()[0]?.state === "working", 1_000, "the start-up scan to see the live turn");

  turnEnded = true;
  await waitFor(() => state.listSessionState()[0]?.state === "idle", 1_000,
    "a turn that ended without a file event to leave Working");
  assert.ok(scannedFiles.slice(1).some((files) => files.includes(transcriptPath)),
    "the tick rereads the Working session's transcript, not every store");
  monitor.stop();

  let scans = 0;
  let enrichments = 0;
  const failing = new SessionMonitor(state, {
    intervalMs: 20,
    scan: async () => {
      scans += 1;
      if (scans > 1) throw new Error("scan failed");
      return [fakeScanRow({ id: "stuck-session", source: "codex", transcriptPath, lastMessageAt: new Date().toISOString(), lastRole: "user", working: true })];
    },
    enrich: async (candidate) => {
      if (candidate.id === "stuck-session") enrichments += 1;
      throw new Error("enrichment retried");
    },
  });
  failing.watch();
  failing.start();
  await waitFor(() => scans > 2 && enrichments > 1, 1_000, "enrichment retries while the Working reread fails");
  failing.stop();
  process.stdout.write("ok — a missed transcript change still settles\n");
} finally {
  monitor.stop();
  state.close();
  cleanup();
}

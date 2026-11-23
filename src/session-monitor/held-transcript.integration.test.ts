import assert from "node:assert";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { SessionMonitor } from "./monitor";

// Codex App keeps each rollout open for the life of the app session. On macOS a directory watch
// (FSEvents) reports writes through a held-open descriptor only when the file is closed.
const { dir, cleanup } = tempOoHome("oo-held-transcript");
const state = new State(join(dir, "state.db"));
const root = join(dir, "sessions");
mkdirSync(join(root, "2026", "11", "23"), { recursive: true });
const transcript = join(root, "2026", "11", "23", "rollout-held.jsonl");
const fd = openSync(transcript, "a");
writeSync(fd, "{}\n");

const scannedFiles: string[][] = [];
const monitor = new SessionMonitor(state, {
  debounceMs: 10,
  scan: async (_since, _limit, files = []) => {
    scannedFiles.push([...files]);
    return [fakeScanRow({ id: "held-session", source: "codex", transcriptPath: transcript, lastMessageAt: new Date().toISOString() })];
  },
});

try {
  monitor.watch([root]);
  await monitor.poll();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = scannedFiles.length;
  writeSync(fd, "{}\n");
  await waitFor(() => scannedFiles.slice(before).some((files) => files.includes(transcript)), 2_000,
    "an append through a held-open descriptor to reach the monitor");
  assert.deepEqual(scannedFiles.at(-1), [transcript], "the append rescans only that transcript");
  process.stdout.write("ok — appends to a held-open transcript reach the monitor\n");
} finally {
  closeSync(fd);
  monitor.stop();
  state.close();
  cleanup();
}

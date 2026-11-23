import assert from "node:assert";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { SessionMonitor } from "./monitor";

// Codex App, the Claude desktop app, and Antigravity hold transcripts open while a session lives.
// On macOS a store's directory watch (FSEvents) reports a write through a held-open descriptor only
// when the file closes, so a session's own transcript watch must carry its writes. No store watch
// is armed here (`watch([])`), so only that per-transcript watch can report a write, on any OS.
const { dir, cleanup } = tempOoHome("oo-held-transcript");
const state = new State(join(dir, "state.db"));
mkdirSync(join(dir, "sessions"), { recursive: true });
const descriptors: number[] = [];
const monitors: SessionMonitor[] = [];

function heldTranscript(name: string): { path: string; fd: number } {
  const path = join(dir, "sessions", name);
  const fd = openSync(path, "a");
  descriptors.push(fd);
  writeSync(fd, "{}\n");
  return { path, fd };
}

function watchedMonitor(id: string, path: string, duringScan?: (call: number) => void, debounceMs = 10) {
  const scans: string[][] = [];
  const monitor = new SessionMonitor(state, {
    debounceMs,
    scan: async (_since, _limit, files = []) => {
      scans.push([...files]);
      duringScan?.(scans.length);
      return [fakeScanRow({ id, source: "codex", transcriptPath: path, lastMessageAt: new Date().toISOString() })];
    },
  });
  monitors.push(monitor);
  monitor.watch([]);
  return { monitor, scans };
}

try {
  const appended = heldTranscript("appended.jsonl");
  const live = watchedMonitor("appended", appended.path);
  await live.monitor.poll();
  await waitFor(() => live.scans.length >= 2, 1_000, "the reread after the watch goes live");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = live.scans.length;
  writeSync(appended.fd, "{}\n");
  await waitFor(() => live.scans.slice(before).some((files) => files.includes(appended.path)), 2_000,
    "an append through a held-open descriptor to reach the monitor");
  assert.deepEqual(live.scans.at(-1), [appended.path], "the append rescans only that transcript");

  const ended = heldTranscript("ended-during-scan.jsonl");
  const racing = watchedMonitor("ended-during-scan", ended.path, (call) => {
    if (call === 1) writeSync(ended.fd, "{\"turn\":\"complete\"}\n");
  });
  await racing.monitor.poll();
  await waitFor(() => racing.scans.slice(1).some((files) => files.includes(ended.path)), 2_000,
    "a write made before the watch was armed to be reread once it is");

  const quiet = heldTranscript("quiet.jsonl");
  const streaming = heldTranscript("streaming.jsonl");
  const burst = watchedMonitor("quiet", quiet.path, undefined, 100);
  burst.monitor.scheduleReconcile(quiet.path);
  let streamed = 0;
  const stream = setInterval(() => { streamed += 1; burst.monitor.scheduleReconcile(streaming.path); }, 20);
  try {
    await waitFor(() => burst.scans.some((files) => files.includes(quiet.path)), 1_000,
      "a queued transcript to be scanned while another transcript streams writes");
    assert.ok(streamed < 50, "the scan came while the stream was still writing");
  } finally {
    clearInterval(stream);
  }
  process.stdout.write("ok — writes to held-open transcripts reach the monitor\n");
} finally {
  for (const monitor of monitors) monitor.stop();
  for (const fd of descriptors) closeSync(fd);
  state.close();
  cleanup();
}

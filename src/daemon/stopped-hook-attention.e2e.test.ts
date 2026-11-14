import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveSessionRoots, type DaemonInfo, type ScanRow, type SessionStateRow } from "@owner-operator/core";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { startDaemon } from "./runtime";

const { dir, cleanup } = tempOoHome("oo-daemon-stopped-attention");
const previousHome = process.env.HOME;
const previousKey = process.env.TYPESAFE_API_KEY;
process.env.HOME = dir;
process.env.TYPESAFE_API_KEY = "test-only";
const originalFetch = globalThis.fetch;
let classificationCalls = 0;
let needsYou = 0.95;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  assert.equal(url.href, "https://api.typesafe.ai/v1/systemone", "the test never calls a live model");
  classificationCalls += 1;
  return Response.json({ model: "fixture", answers: {
    needs_you: { type: "noul", noul: needsYou },
    awaiting: { type: "noul", noul: 0 },
  } });
};
const sessionId = "11111111-2222-4333-8444-555555555555";
const root = join(dir, ".claude", "projects");
const project = join(root, "-repair");
mkdirSync(project, { recursive: true });
saveSessionRoots(dir, [{ source: "claude", root }]);
const transcript = join(project, `${sessionId}.jsonl`);
const stamp = new Date().toISOString();
writeFileSync(transcript, [
  { type: "user", sessionId, cwd: "/work/repair", timestamp: stamp,
    message: { role: "user", content: [{ type: "text", text: "Complete and verify the repair." }] } },
  { type: "assistant", sessionId, cwd: "/work/repair", timestamp: stamp,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "The repair needs your review before I can finish." }] } },
].map((record) => JSON.stringify(record)).join("\n"));
let scanned: ScanRow[] = [];
const logs: string[] = [];
const daemon = await startDaemon({
  port: 0, dbPath: join(dir, "state.db"), watch: false,
  monitor: {
    scan: async () => scanned,
    intervalMs: 60_000,
    debounceMs: 10,
    canEnrich: () => true,
    logger: ({ error }) => logs.push(error),
  },
});
const discovery: DaemonInfo = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
const endpoint = `http://127.0.0.1:${daemon.port}`;
const headers = { authorization: `Bearer ${discovery.authToken}`, "content-type": "application/json" };

async function hook(hook_event_name: string, fields: Record<string, unknown> = {}): Promise<void> {
  const response = await fetch(`${endpoint}/hooks/claude`, {
    method: "POST", headers, body: JSON.stringify({ session_id: sessionId, hook_event_name, ...fields }),
  });
  assert.equal(response.status, 200);
}

async function current(): Promise<SessionStateRow | undefined> {
  const response = await fetch(`${endpoint}/session-state`, { headers });
  const rows: SessionStateRow[] = await response.json();
  return rows.find((row) => row.id === sessionId);
}

try {
  await hook("UserPromptSubmit", { prompt: "Complete and verify the repair." });
  scanned = [fakeScanRow({ id: sessionId, source: "claude", transcriptPath: transcript, lastMessageAt: stamp })];
  await daemon.monitor.poll();
  await waitFor(() => logs.length > 0, 10_000, "the working account attempt to settle without model credentials");
  assert.equal(classificationCalls, 0, "the daemon skips task classification while a hook proves Working");
  assert.equal((await current())?.state, "working");

  await hook("Stop");
  await waitFor(() => daemon.state.listSessionState().find((row) => row.id === sessionId)?.state === "needs-you",
    10_000, "Stop after the final scan wakes the real daemon classifier");
  assert.equal(classificationCalls, 1, "the default daemon composition classifies a stopped hooked task");
  assert.equal((await current())?.state, "needs-you", "the classified owner obligation reaches the session-state API");

  needsYou = 0.05;
  const callsBeforeWait = classificationCalls;
  const logsBeforeWait = logs.length;
  await hook("PermissionRequest", { tool_name: "Write" });
  await waitFor(() => logs.length > logsBeforeWait, 10_000, "the permission account attempt");
  assert.equal(classificationCalls, callsBeforeWait, "a live permission does not ask the unfinished-task classifier");
  assert.equal((await current())?.state, "needs-you");

  await hook("UserPromptSubmit", { prompt: "The review is complete. Finish." });
  await hook("Stop");
  await waitFor(() => classificationCalls > callsBeforeWait, 10_000, "a new stopped turn receives a new assessment");
  await waitFor(() => daemon.state.listSessionState().find((row) => row.id === sessionId)?.state === "idle",
    10_000, "a completed assessment reaches Idle");
  assert.equal((await current())?.state, "idle");
  console.log("ok - the daemon classifies stopped hook tasks and keeps live hook authority");
} finally {
  await daemon.close();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
  cleanup();
}

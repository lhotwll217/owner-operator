import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectGateway } from "../gateway/client";
import { waitFor } from "../gateway/test/helpers";
import { ensureDaemon } from "./ensure";
import { startDaemon } from "./runtime";

const root = mkdtempSync(join(tmpdir(), "oo-shutdown-discovery-"));
const oldEnv = { HOME: process.env.HOME, OO_HOME: process.env.OO_HOME, OO_PORT: process.env.OO_PORT };
process.env.HOME = join(root, "home");
process.env.OO_HOME = join(root, "oo");
mkdirSync(process.env.HOME);
const discovery = join(process.env.OO_HOME, "daemon.json");
let releaseRequest!: () => void;
const blocked = new Promise<void>((resolve) => { releaseRequest = resolve; });
let enteredRequest!: () => void;
const entered = new Promise<void>((resolve) => { enteredRequest = resolve; });
const old = await startDaemon({
  port: 0,
  watch: false,
  enableEnrichment: false,
  monitor: { scan: async () => [], intervalMs: 60_000 },
  harness: { details: async () => { enteredRequest(); await blocked; return { drained: true }; } },
});
process.env.OO_PORT = String(old.port);
let closing: Promise<void> | undefined;
let pending: Promise<unknown> | undefined;
let replacementPid: number | undefined;
try {
  const client = await connectGateway();
  assert.ok(client);
  pending = client.harnessDetails({});
  await entered;
  closing = old.close();
  let portReleased = false;
  for (let attempt = 0; attempt < 60 && !portReleased; attempt++) {
    portReleased = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(old.port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (!portReleased) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(portReleased, true, "the old Gateway releases its listener while the request drains");
  await ensureDaemon();
  const replacementInfo = JSON.parse(readFileSync(discovery, "utf8")) as { pid: number; startedAt: string };
  replacementPid = replacementInfo.pid;
  assert.notEqual(replacementPid, process.pid, "ensure starts a separate daemon during the drain window");
  releaseRequest();
  assert.deepEqual(await pending, { drained: true });
  await closing;
  client.close();

  assert.equal(existsSync(discovery), true, "draining daemon must preserve replacement discovery");
  const replacement = await connectGateway();
  assert.ok(replacement, "the replacement remains discoverable after the old daemon closes");
  const health = await replacement.health();
  assert.equal(health.pid, replacementPid);
  assert.equal(health.startedAt, replacementInfo.startedAt);
  replacement.close();
  console.log("ok - a draining daemon preserves its replacement's discovery and Gateway connection");
} finally {
  releaseRequest();
  await pending;
  await (closing ?? old.close());
  if (replacementPid && replacementPid !== process.pid) {
    try { process.kill(replacementPid, "SIGTERM"); } catch { /* already exited */ }
    await waitFor(() => {
      try { process.kill(replacementPid!, 0); return false; } catch { return true; }
    }, 5_000, "isolated replacement exits");
  }
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

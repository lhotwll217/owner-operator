import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "oo-gateway-subscription-"));
const previousOoHome = process.env.OO_HOME;
const previousFetch = globalThis.fetch;
process.env.OO_HOME = root;
mkdirSync(root, { recursive: true });

const daemon = {
  port: 41_111,
  pid: 51_111,
  startedAt: "gateway-subscription-test",
  fingerprint: "gateway-subscription-test",
  authToken: "gateway-subscription-test",
};
writeFileSync(join(root, "daemon.json"), JSON.stringify(daemon));

let streams = 0;
let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
globalThis.fetch = (input) => {
  const path = new URL(String(input)).pathname;
  if (path === "/health") {
    return Promise.resolve(Response.json({
      ok: true,
      port: daemon.port,
      pid: daemon.pid,
      startedAt: daemon.startedAt,
      fingerprint: daemon.fingerprint,
      stale: false,
    }));
  }
  if (path === "/ready") {
    return Promise.resolve(Response.json({
      ready: true,
      modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true },
    }));
  }
  if (path === "/events") {
    streams += 1;
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (streams === 1) firstController = controller;
      },
    }), { headers: { "content-type": "text/event-stream" } }));
  }
  return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
};

const waitFor = async (check: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 2_500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

try {
  const { connectGateway } = await import("./client");
  const gateway = await connectGateway();
  assert.ok(gateway);
  let connected = 0;
  let disconnected = 0;
  const unsubscribe = gateway.subscribe(
    () => undefined,
    () => { connected += 1; },
    () => { disconnected += 1; },
  );
  await waitFor(() => connected === 1, "initial SSE connection");
  firstController?.close();
  await waitFor(() => disconnected === 1, "SSE disconnect callback");
  await waitFor(() => connected === 2, "replacement SSE connection");
  assert.equal(disconnected, 1, "one lost stream produces one disconnect transition");
  unsubscribe();
  gateway.close();
  process.stdout.write("ok — Gateway subscriptions expose disconnect and reconnect transitions\n");
} finally {
  globalThis.fetch = previousFetch;
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(root, { recursive: true, force: true });
}

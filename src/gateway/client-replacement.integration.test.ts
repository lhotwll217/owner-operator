import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "oo-gateway-target-race-"));
const previousOoHome = process.env.OO_HOME;
const previousFetch = globalThis.fetch;
process.env.OO_HOME = root;
mkdirSync(root, { recursive: true });

const daemon = (id: "a" | "b") => ({
  port: id === "a" ? 41_101 : 41_102,
  pid: id === "a" ? 51_101 : 51_102,
  startedAt: id,
  fingerprint: id,
  authToken: id,
});
const writeDaemon = (id: "a" | "b"): void => {
  writeFileSync(join(root, "daemon.json"), JSON.stringify(daemon(id)));
};
const health = (id: "a" | "b") => ({
  ok: true,
  port: daemon(id).port,
  pid: daemon(id).pid,
  startedAt: id,
  fingerprint: id,
  stale: false,
});
const ready = { ready: true, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } };

let phase: "sse-first" | "sse-late" = "sse-first";
let initialHealthCalls = 0;
let rejectInFlight!: (error: Error) => void;
let resolveOldStream!: (response: Response) => void;
globalThis.fetch = (input) => {
  const url = String(input);
  if (url === `http://127.0.0.1:${daemon("a").port}/health`) {
    initialHealthCalls += 1;
    if (initialHealthCalls === 1) return Promise.resolve(Response.json(health("a")));
    if (initialHealthCalls > 2) return Promise.resolve(Response.json(health("a")));
    return new Promise<Response>((_resolve, reject) => { rejectInFlight = reject; });
  }
  if (url === `http://127.0.0.1:${daemon("a").port}/ready`) return Promise.resolve(Response.json(ready));
  if (url === `http://127.0.0.1:${daemon("a").port}/events` && phase === "sse-late") {
    return new Promise<Response>((resolve) => { resolveOldStream = resolve; });
  }
  if (url === `http://127.0.0.1:${daemon("b").port}/events`) {
    return Promise.resolve(new Response(new ReadableStream({ start() {} }), {
      headers: { "content-type": "text/event-stream" },
    }));
  }
  if (url === `http://127.0.0.1:${daemon("b").port}/health`) return Promise.resolve(Response.json(health("b")));
  return Promise.reject(new Error(`unexpected fetch ${url}`));
};

try {
  writeDaemon("a");
  const { connectGateway } = await import("./client");
  const gateway = await connectGateway();
  assert.ok(gateway);
  const inFlight = gateway.health();
  writeDaemon("b");
  let connected!: () => void;
  const connectedPromise = new Promise<void>((resolve) => { connected = resolve; });
  const unsubscribe = gateway.subscribe(() => undefined, connected);
  await connectedPromise;
  rejectInFlight(new Error("daemon a closed"));
  assert.equal((await inFlight).pid, daemon("b").pid, "safe GET retries relative to its request snapshot");
  unsubscribe();
  gateway.close();

  phase = "sse-late";
  initialHealthCalls = 0;
  writeDaemon("a");
  const secondGateway = await connectGateway();
  assert.ok(secondGateway);
  let lateConnected!: () => void;
  const lateConnectedPromise = new Promise<void>((resolve) => { lateConnected = resolve; });
  const unsubscribeSecond = secondGateway.subscribe(() => undefined, lateConnected);
  const secondInFlight = secondGateway.health();
  writeDaemon("b");
  rejectInFlight(new Error("daemon a closed during its event connection"));
  assert.equal((await secondInFlight).pid, daemon("b").pid);
  resolveOldStream(new Response(new ReadableStream({ start() {} }), {
    headers: { "content-type": "text/event-stream" },
  }));
  await lateConnectedPromise;
  assert.equal(
    (await secondGateway.health()).pid,
    daemon("b").pid,
    "a late old SSE connection cannot regress the adopted Gateway target",
  );
  unsubscribeSecond();
  secondGateway.close();
  process.stdout.write("ok — concurrent Gateway replacement keeps the newest durable target\n");
} finally {
  globalThis.fetch = previousFetch;
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(root, { recursive: true, force: true });
}

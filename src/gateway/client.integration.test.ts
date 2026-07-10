import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayEventKind, type GatewayEvent } from "@owner-operator/core";
import { waitFor } from "./test/helpers";
import { connectGateway, resolveBackend } from "./client";

const root = mkdtempSync(join(tmpdir(), "oo-gateway-client-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = root;
mkdirSync(root, { recursive: true });

const token = "client-test-token";
const fingerprint = "client-test-fingerprint";
const pid = 41_001;
const streams = new Set<ServerResponse>();
let retired = false;
let boundPort = 0;
const server = createServer((request, response) => {
  if (retired || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ ok: true, port: boundPort, pid, startedAt: "now", fingerprint, stale: false }));
  } else if (request.url === "/ready") {
    response.end(JSON.stringify({ ready: true, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }));
  } else if (request.url === "/poll") {
    setTimeout(() => response.end(JSON.stringify({ ok: true })), 2_100);
  } else if (request.url === "/events") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(":ready\n\n");
    streams.add(response);
    request.on("close", () => streams.delete(response));
  } else {
    response.writeHead(404).end();
  }
});

try {
  boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  writeFileSync(join(root, "daemon.json"), JSON.stringify({ port: boundPort, pid, startedAt: "now", fingerprint, authToken: token }));
  const gateway = await connectGateway();
  assert.ok(gateway);
  await gateway!.poll();
  gateway!.close();

  const memoized = await resolveBackend();
  const events: GatewayEvent[] = [];
  const unsubscribe = memoized.subscribe((event) => events.push(event));
  await waitFor(() => streams.size === 1, 1_000, "initial event subscription");

  const replacementToken = "replacement-token";
  const replacementPid = 41_002;
  const replacementFingerprint = "replacement-fingerprint";
  const replacementServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${replacementToken}`) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({
        ok: true,
        port: (replacementServer.address() as { port: number }).port,
        pid: replacementPid,
        startedAt: "later",
        fingerprint: replacementFingerprint,
        stale: false,
      }));
    } else if (request.url === "/ready") {
      response.end(JSON.stringify({ ready: true, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }));
    } else if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ kind: GatewayEventKind.StateChanged })}\n\n`);
    } else {
      response.writeHead(404).end();
    }
  });
  const replacementPort = await new Promise<number>((resolve, reject) => {
    replacementServer.once("error", reject);
    replacementServer.listen(0, "127.0.0.1", () => resolve((replacementServer.address() as { port: number }).port));
  });
  try {
    writeFileSync(join(root, "daemon.json"), JSON.stringify({
      port: replacementPort,
      pid: replacementPid,
      startedAt: "later",
      fingerprint: replacementFingerprint,
      authToken: replacementToken,
    }));
    retired = true;
    for (const stream of streams) stream.end();
    streams.clear();
    await assert.rejects(() => memoized.health(), /401/, "the retired client observes daemon replacement");
    const replacement = await resolveBackend();
    assert.equal((await replacement.health()).pid, replacementPid, "the next tool call resolves fresh discovery");
    await waitFor(
      () => events.some((event) => event.kind === GatewayEventKind.StateChanged),
      2_500,
      "event subscription reconnects through fresh discovery",
    );
    replacement.close();
  } finally {
    unsubscribe();
    await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
  }
  process.stdout.write("ok — gateway client request lifetimes and replacement recovery\n");
} finally {
  for (const stream of streams) stream.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(root, { recursive: true, force: true });
}

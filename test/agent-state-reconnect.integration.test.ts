import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { ParentRunSession, gatewayParentRunAdapter } from "../src/agent-runs/parent-run-session";
import { connectGateway } from "../src/gateway/client";
import { waitFor } from "../src/gateway/test/helpers";
import { agentRunFixture } from "./fixtures/agent-run";

const root = mkdtempSync(join(tmpdir(), "oo-agent-state-reconnect-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = root;
mkdirSync(root, { recursive: true });

const initialToken = "agent-state-initial";
const initialStreams = new Set<ServerResponse>();
let initialPort = 0;
let retired = false;
let initialServerClosed = false;
const durableRun = (status: AgentRunStatus) => agentRunFixture("replacement-run", status, {
  harness: AgentRunHarness.Codex,
  task: "verify daemon replacement",
  parentThreadId: "parent-reconnect",
  childSessionId: "replacement-child",
  activity: status === AgentRunStatus.Running ? "watching the old daemon" : "final checks complete",
  finishedAt: status === AgentRunStatus.Completed ? "2026-07-21T12:09:00.000Z" : null,
  resultTail: status === AgentRunStatus.Completed ? "replacement survived" : null,
});
const initialServer = createServer((request, response) => {
  if (retired || request.headers.authorization !== `Bearer ${initialToken}`) {
    response.writeHead(401).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ ok: true, port: initialPort, pid: 51_001, startedAt: "first", fingerprint: "first", stale: false }));
  } else if (request.url === "/ready") {
    response.end(JSON.stringify({ ready: true, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }));
  } else if (request.url === "/agent-runs?parentThreadId=parent-reconnect") {
    response.end(JSON.stringify([durableRun(AgentRunStatus.Running)]));
  } else if (request.url === "/events") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(":ready\n\n");
    initialStreams.add(response);
    request.on("close", () => initialStreams.delete(response));
  } else {
    response.writeHead(404).end();
  }
});

let open: ParentRunSession | undefined;
let reopened: ParentRunSession | undefined;
let initialGateway: Awaited<ReturnType<typeof connectGateway>>;
let replacementGateway: Awaited<ReturnType<typeof connectGateway>>;
let replacementServer: ReturnType<typeof createServer> | undefined;
const replacementStreams = new Set<ServerResponse>();

try {
  initialPort = await new Promise<number>((resolve, reject) => {
    initialServer.once("error", reject);
    initialServer.listen(0, "127.0.0.1", () => resolve((initialServer.address() as { port: number }).port));
  });
  writeFileSync(join(root, "daemon.json"), JSON.stringify({
    port: initialPort,
    pid: 51_001,
    startedAt: "first",
    fingerprint: "first",
    authToken: initialToken,
  }));
  initialGateway = await connectGateway();
  assert.ok(initialGateway);
  open = new ParentRunSession("parent-reconnect", gatewayParentRunAdapter(initialGateway!), {
    now: () => "2026-07-21T12:10:00.000Z",
  });
  await open.start();
  assert.equal(open.view.runs[0]?.status.text, "running");
  await waitFor(() => initialStreams.size === 1, 1_000, "initial parent subscription");

  const replacementToken = "agent-state-replacement";
  let replacementPort = 0;
  replacementServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${replacementToken}`) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, port: replacementPort, pid: 51_002, startedAt: "second", fingerprint: "second", stale: false }));
    } else if (request.url === "/ready") {
      response.end(JSON.stringify({ ready: true, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }));
    } else if (request.url === "/agent-runs?parentThreadId=parent-reconnect") {
      response.end(JSON.stringify([durableRun(AgentRunStatus.Completed)]));
    } else if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(":ready\n\n");
      replacementStreams.add(response);
      request.on("close", () => replacementStreams.delete(response));
    } else {
      response.writeHead(404).end();
    }
  });
  replacementPort = await new Promise<number>((resolve, reject) => {
    replacementServer!.once("error", reject);
    replacementServer!.listen(0, "127.0.0.1", () => resolve((replacementServer!.address() as { port: number }).port));
  });
  writeFileSync(join(root, "daemon.json"), JSON.stringify({
    port: replacementPort,
    pid: 51_002,
    startedAt: "second",
    fingerprint: "second",
    authToken: replacementToken,
  }));
  for (const stream of initialStreams) stream.end();
  await new Promise<void>((resolve) => initialServer.close(() => resolve()));
  initialServerClosed = true;

  await waitFor(
    () => open?.view.runs[0]?.status.text === "completed",
    2_500,
    "connection callback refetches terminal truth without a replayed domain event",
  );
  replacementGateway = await connectGateway();
  assert.ok(replacementGateway);
  reopened = new ParentRunSession("parent-reconnect", gatewayParentRunAdapter(replacementGateway!), {
    now: () => "2026-07-21T12:10:00.000Z",
  });
  await reopened.start();
  assert.deepEqual(reopened.view, open.view, "reopening reconstructs the same durable projection");

  process.stdout.write("ok — parent agent state survives Gateway reconnect, daemon replacement, and reopening\n");
} finally {
  open?.stop();
  reopened?.stop();
  initialGateway?.close();
  replacementGateway?.close();
  for (const stream of initialStreams) stream.end();
  for (const stream of replacementStreams) stream.end();
  if (!initialServerClosed) await new Promise<void>((resolve) => initialServer.close(() => resolve()));
  if (replacementServer) await new Promise<void>((resolve) => replacementServer!.close(() => resolve()));
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(root, { recursive: true, force: true });
}

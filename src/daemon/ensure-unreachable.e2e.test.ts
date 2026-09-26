import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { reportFailure } from "../cli/operations/operation";
import { connectGateway } from "../gateway/client";
import { ensureDaemon } from "./ensure";
import { runtimeFingerprint } from "./fingerprint";

const root = mkdtempSync(join(tmpdir(), "oo-ensure-unreachable-"));
const home = join(root, "home");
const ooHome = join(home, ".owner-operator");
const bin = join(root, "bin");
const launchLog = join(root, "launchctl.log");
const oldEnv = { HOME: process.env.HOME, OO_HOME: process.env.OO_HOME, PATH: process.env.PATH };
mkdirSync(ooHome, { recursive: true });
mkdirSync(bin);
const launchAgents = join(home, "Library", "LaunchAgents");
mkdirSync(launchAgents, { recursive: true });
const launchAgent = join(launchAgents, "com.owner-operator.daemon.plist");
writeFileSync(launchAgent, "installed\n");
const launchctl = join(bin, "launchctl");
writeFileSync(launchctl, `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(launchLog)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "enable") process.exit(0);
process.stderr.write("unexpected launchctl call\\n");
process.exit(99);
`);
chmodSync(launchctl, 0o755);
process.env.HOME = home;
process.env.OO_HOME = ooHome;
process.env.PATH = `${bin}:${oldEnv.PATH ?? ""}`;

const child = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1000); process.stdout.write("alive\\n");'], {
  stdio: ["ignore", "pipe", "inherit"],
});
const server = createServer();
const recovery = `launchctl kickstart -k gui/${process.getuid?.()}/com.owner-operator.daemon`;
function assertReportedFailure(error: unknown, cause: RegExp, command = recovery): boolean {
  assert.ok(error instanceof Error);
  for (const json of [false, true]) {
    let output = "";
    const write = mock.method(process.stderr, "write", (chunk: unknown) => { output += String(chunk); return true; });
    try { reportFailure(error, json); } finally { write.mock.restore(); }
    const message = json ? JSON.parse(output).error as string : output;
    assert.match(message, /is running but this process cannot reach/);
    assert.match(message, cause);
    assert.ok(message.includes(command), "the CLI reports the applicable manual recovery command");
  }
  assert.equal(existsSync(launchLog), false, "failure leaves the process running without supervisor calls");
  return true;
}
try {
  await once(child.stdout, "data");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(child.pid);
  process.kill(child.pid, 0);
  const info = {
    port,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    fingerprint: runtimeFingerprint(),
    authToken: "unreachable-token",
  };
  const discovery = join(ooHome, "daemon.json");
  writeFileSync(discovery, JSON.stringify(info));

  await assert.rejects(
    ensureDaemon(),
    /Command failed: launchctl kickstart -k/,
    "stale discovery with a reused live PID and no listener still requests startup",
  );
  assert.equal(existsSync(launchLog), true, "a free port permits startup despite the live PID");
  rmSync(launchLog);
  process.kill(child.pid, 0);
  console.log("ok - stale discovery with a reused live PID and no listener requests startup");

  const bind = mock.method(Server.prototype, "listen", function (this: Server) {
    this.emit("error", Object.assign(new Error("bind EPERM"), { code: "EPERM" }));
    return this;
  });
  try {
    await assert.rejects(ensureDaemon(), /Command failed: launchctl kickstart -k/);
    rmSync(launchLog);
  } finally {
    bind.mock.restore();
  }
  console.log("ok - ECONNREFUSED permits startup even when binding would be denied");

  const denied = new TypeError("fetch failed", { cause: Object.assign(new Error("connect EPERM"), { code: "EPERM" }) });
  const deniedFetch = mock.method(globalThis, "fetch", async () => { throw denied; });
  try {
    await assert.rejects(ensureDaemon(), /Command failed: launchctl kickstart -k/);
    rmSync(launchLog);
  } finally {
    deniedFetch.mock.restore();
  }
  console.log("ok - a successful port bind permits startup after a failed probe");

  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await assert.rejects(ensureDaemon(), (error: unknown) => {
    assertReportedFailure(error, /TimeoutError.*timeout/);
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /sandbox/);
    return true;
  });
  console.log("ok - a hung listener reports the real timeout and manual recovery through the CLI");

  for (const cause of [
    denied,
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  ]) {
    const fetch = mock.method(globalThis, "fetch", async () => { throw cause; });
    try {
      await assert.rejects(ensureDaemon(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, cause, "the original probe failure survives the lifecycle error");
        return assertReportedFailure(error, cause === denied ? /EPERM.*sandbox/ : /TimeoutError.*timeout/);
      });
      assert.equal(await connectGateway(), null, "ordinary connection failure still returns null");
      assert.equal(existsSync(launchLog), false);
    } finally {
      fetch.mock.restore();
    }
  }
  console.log("ok - sandbox and timeout failures retain their original cause");

  const kill = mock.method(process, "kill", () => {
    throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
  });
  const fetchDenied = mock.method(globalThis, "fetch", async () => { throw denied; });
  const bindDenied = mock.method(Server.prototype, "listen", function (this: Server) {
    this.emit("error", Object.assign(new Error("bind EPERM"), { code: "EPERM" }));
    return this;
  });
  try {
    await assert.rejects(ensureDaemon(), (error) => assertReportedFailure(error, /EPERM.*sandbox/));
  } finally {
    kill.mock.restore();
    fetchDenied.mock.restore();
    bindDenied.mock.restore();
  }
  console.log("ok - denied connect, bind, and PID checks cannot authorize restart");

  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
  try {
    await assert.rejects(ensureDaemon(), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.doesNotMatch(error.message, /sandbox/);
      return assertReportedFailure(error, /gateway \/health: 401 unauthorized/);
    });
    assert.equal(existsSync(launchLog), false, "authentication failure cannot authorize restart");
  } finally {
    fetch.mock.restore();
  }
  console.log("ok - authentication failure reports HTTP 401 through the CLI without restart");

  for (const mismatch of [{ pid: child.pid + 1 }, { fingerprint: "other-fingerprint" }]) {
    const mismatchFetch = mock.method(globalThis, "fetch", async (input: unknown) =>
      Response.json(String(input).endsWith("/health") ? { ...info, ...mismatch } : { ready: true }),
    );
    try {
      await assert.rejects(ensureDaemon(), (error) => assertReportedFailure(error, /identity does not match daemon discovery/));
      rmSync(launchAgent);
      await assert.rejects(ensureDaemon(), (error) =>
        assertReportedFailure(error, /identity does not match daemon discovery/, `kill ${child.pid}`),
      );
    } finally {
      writeFileSync(launchAgent, "installed\n");
      mismatchFetch.mock.restore();
    }
  }
  console.log("ok - identity mismatches report their cause and the applicable manual recovery command");

  for (const pid of [undefined, null, 0, -1, 1.5, "1", 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    writeFileSync(discovery, JSON.stringify({ pid }));
    await assert.rejects(ensureDaemon(), /Command failed: launchctl kickstart -k/);
    rmSync(launchLog);
  }
  writeFileSync(discovery, JSON.stringify(info));
  console.log("ok - missing or invalid discovery PIDs permit startup");

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  await assert.rejects(ensureDaemon(), /Command failed: launchctl kickstart -k/);
  assert.equal(existsSync(launchLog), true, "a truly exited PID still requests startup");
  console.log("ok - a truly exited PID still requests daemon startup");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

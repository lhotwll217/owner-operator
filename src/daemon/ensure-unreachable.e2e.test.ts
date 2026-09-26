import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
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
writeFileSync(join(launchAgents, "com.owner-operator.daemon.plist"), "installed\n");
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
try {
  await once(child.stdout, "data");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(child.pid);
  process.kill(child.pid, 0);
  writeFileSync(join(ooHome, "daemon.json"), JSON.stringify({
    port,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    fingerprint: runtimeFingerprint(),
    authToken: "unreachable-token",
  }));

  await assert.rejects(
    ensureDaemon(),
    new RegExp(`daemon pid ${child.pid} is running but this process cannot reach 127\\.0\\.0\\.1:${port}.*sandbox`),
  );
  assert.equal(existsSync(launchLog), false, "an unreachable live PID never reaches launchctl");
  process.kill(child.pid, 0);
  console.log("ok - running but unreachable daemon reports its PID and address without restart");

  const kill = mock.method(process, "kill", () => {
    throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
  });
  try {
    await assert.rejects(ensureDaemon(), /is running but this process cannot reach/);
    assert.equal(existsSync(launchLog), false, "EPERM is not evidence that the daemon exited");
  } finally {
    kill.mock.restore();
  }
  console.log("ok - a denied PID check does not authorize restart");

  for (const cause of [
    new TypeError("fetch failed", { cause: Object.assign(new Error("connect EPERM"), { code: "EPERM" }) }),
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  ]) {
    const fetch = mock.method(globalThis, "fetch", async () => { throw cause; });
    try {
      await assert.rejects(ensureDaemon(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /is running but this process cannot reach/);
        assert.equal(error.cause, cause, "the original probe failure survives the lifecycle error");
        return true;
      });
      assert.equal(await connectGateway(), null, "ordinary connection failure still returns null");
      assert.equal(existsSync(launchLog), false);
    } finally {
      fetch.mock.restore();
    }
  }
  console.log("ok - sandbox and timeout failures retain their original cause");

  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
  try {
    await assert.rejects(ensureDaemon(), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.match(error.message, /is running but this process cannot reach/);
      assert.match(error.cause.message, /gateway \/health: 401/);
      return true;
    });
    assert.equal(existsSync(launchLog), false, "authentication failure cannot authorize restart");
  } finally {
    fetch.mock.restore();
  }
  console.log("ok - authentication failure leaves the live process running");

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  await assert.rejects(ensureDaemon(), /Command failed: launchctl kickstart -k/);
  assert.equal(existsSync(launchLog), true, "a truly exited PID still requests startup");
  console.log("ok - a truly exited PID still requests daemon startup");
} finally {
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

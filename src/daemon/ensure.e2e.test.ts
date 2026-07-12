import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connectGateway } from "../gateway/client";
import { repoRoot } from "../shared/repo-root";
import { ensureDaemon } from "./ensure";

const root = mkdtempSync(join(tmpdir(), "oo-ensure-daemon-"));
const home = join(root, "home");
const ooHome = join(home, ".owner-operator");
const bin = join(root, "bin");
const launchLog = join(root, "launchctl.log");
const daemonLog = join(root, "spawned-daemon.log");
const oldEnv = { HOME: process.env.HOME, OO_HOME: process.env.OO_HOME, OO_PORT: process.env.OO_PORT, PATH: process.env.PATH };

const freePort = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resolve(port));
  });
});

mkdirSync(bin, { recursive: true });
mkdirSync(ooHome, { recursive: true });
const launchAgent = join(home, "Library", "LaunchAgents", "com.owner-operator.daemon.plist");
mkdirSync(dirname(launchAgent), { recursive: true });
writeFileSync(launchAgent, "installed\n");
const fakeLaunchctl = join(bin, "launchctl");
writeFileSync(fakeLaunchctl, `#!/usr/bin/env node
const { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.OO_TEST_LAUNCH_LOG, args.join(" ") + "\\n");
if (args[0] === "print") {
  process.exit(existsSync(process.env.OO_TEST_PRINT_VERIFIED_MARKER) ? 113 : 0);
}
if (args[0] !== "kickstart") process.exit(0);
if (!existsSync(process.env.OO_TEST_KICKSTART_MARKER)) {
  writeFileSync(process.env.OO_TEST_KICKSTART_MARKER, "failed once\\n");
  process.exit(113);
}
try {
  const info = JSON.parse(readFileSync(join(process.env.OO_TEST_OO_HOME, "daemon.json"), "utf8"));
  process.kill(info.pid, "SIGTERM");
  appendFileSync(process.env.OO_TEST_LAUNCH_LOG, "supervisor-stop " + info.pid + "\\n");
} catch {}
const log = openSync(process.env.OO_TEST_DAEMON_LOG, "a");
const child = spawn(process.env.OO_TEST_BIN, ["daemon"], {
  cwd: process.env.OO_TEST_REPO,
  detached: true,
  env: process.env,
  stdio: ["ignore", log, log],
});
closeSync(log);
child.unref();
`);
chmodSync(fakeLaunchctl, 0o755);

process.env.HOME = home;
process.env.OO_HOME = ooHome;
process.env.OO_PORT = String(freePort);
process.env.PATH = `${bin}:${oldEnv.PATH ?? ""}`;
process.env.OO_TEST_BIN = join(repoRoot, "oo");
process.env.OO_TEST_REPO = repoRoot;
process.env.OO_TEST_LAUNCH_LOG = launchLog;
process.env.OO_TEST_DAEMON_LOG = daemonLog;
process.env.OO_TEST_OO_HOME = ooHome;
process.env.OO_TEST_KICKSTART_MARKER = join(root, "kickstart.marker");
process.env.OO_TEST_PRINT_VERIFIED_MARKER = join(root, "print-verified.marker");

const token = "stale-token";
const staleFingerprint = "stale-fingerprint";
const blocker = spawn(process.execPath, ["-e", `
  const http = require("node:http");
  const port = Number(process.env.OO_PORT);
  const token = ${JSON.stringify(token)};
  const fingerprint = ${JSON.stringify(staleFingerprint)};
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer " + token) { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, port, pid: process.pid, startedAt: new Date().toISOString(), fingerprint, stale: true }));
    } else if (request.url === "/ready") {
      response.writeHead(503);
      response.end(JSON.stringify({ ready: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }));
    } else { response.writeHead(404).end(); }
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  server.listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));
`], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const stopProcess = async (pid: number | null | undefined): Promise<void> => {
  if (!pid || !isAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40 && isAlive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

let daemonPid: number | null = null;
try {
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.stdout.once("data", () => resolve());
  });
  writeFileSync(join(ooHome, "daemon.json"), JSON.stringify({
    port: freePort,
    pid: blocker.pid,
    startedAt: new Date().toISOString(),
    fingerprint: staleFingerprint,
    authToken: token,
  }));

  await assert.rejects(
    () => ensureDaemon(),
    /could not verify launchd ownership/,
    "an ambiguous launchctl result never authorizes direct signaling",
  );
  assert.equal(isAlive(blocker.pid!), true, "unknown ownership leaves the authenticated daemon running");
  writeFileSync(process.env.OO_TEST_PRINT_VERIFIED_MARKER, "not loaded\n");

  await ensureDaemon();
  assert.equal(isAlive(blocker.pid!), false, "authenticated stale daemon is stopped before replacement");
  const supervisorLog = readFileSync(launchLog, "utf8");
  assert.match(
    supervisorLog,
    /print gui\/\d+\/com\.owner-operator\.daemon[\s\S]*enable gui\/\d+\/com\.owner-operator\.daemon[\s\S]*kickstart -k[\s\S]*bootstrap gui\/\d+ .*\.plist[\s\S]*kickstart -k/,
    "an installed-but-unloaded LaunchAgent is enabled, bootstrapped, and retried",
  );
  assert.doesNotMatch(
    supervisorLog,
    /supervisor-stop/,
    "the authenticated detached daemon is handed off before launchd starts its replacement",
  );
  const gateway = await connectGateway();
  assert.ok(gateway, "launchd-owned replacement becomes ready");
  const health = await gateway!.health();
  daemonPid = health.pid;
  assert.notEqual(health.pid, blocker.pid, "the replacement owns the discovery record");
  gateway!.close();
  process.stdout.write("ok — ensure daemon replaces stale identity through the installed supervisor\n");
} finally {
  await stopProcess(blocker.pid);
  await stopProcess(daemonPid);
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.OO_TEST_BIN;
  delete process.env.OO_TEST_REPO;
  delete process.env.OO_TEST_LAUNCH_LOG;
  delete process.env.OO_TEST_DAEMON_LOG;
  delete process.env.OO_TEST_OO_HOME;
  delete process.env.OO_TEST_KICKSTART_MARKER;
  delete process.env.OO_TEST_PRINT_VERIFIED_MARKER;
  rmSync(root, { recursive: true, force: true });
}

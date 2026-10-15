import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "../shared/repo-root";
import { ensureDaemon } from "./ensure";

const root = mkdtempSync(join(tmpdir(), "oo-ensure-other-checkout-"));
const home = join(root, "home");
const ooHome = join(home, ".owner-operator");
const bin = join(root, "bin");
const launchLog = join(root, "launchctl.log");
const daemonRootFile = join(root, "daemon-root");
const oldEnv = { HOME: process.env.HOME, OO_HOME: process.env.OO_HOME, OO_PORT: process.env.OO_PORT, PATH: process.env.PATH };

const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
  });
});

mkdirSync(bin, { recursive: true });
mkdirSync(ooHome, { recursive: true });
const launchAgent = join(home, "Library", "LaunchAgents", "com.owner-operator.daemon.plist");
mkdirSync(dirname(launchAgent), { recursive: true });
writeFileSync(launchAgent, "installed\n");
writeFileSync(join(bin, "launchctl"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.OO_TEST_LAUNCH_LOG, args.join(" ") + "\\n");
if (args[0] === "print") process.stdout.write("\\tpid = " + process.env.OO_TEST_DAEMON_PID + "\\n");
`);
chmodSync(join(bin, "launchctl"), 0o755);

process.env.HOME = home;
process.env.OO_HOME = ooHome;
process.env.OO_PORT = String(port);
process.env.PATH = `${bin}:${oldEnv.PATH ?? ""}`;
process.env.OO_TEST_LAUNCH_LOG = launchLog;

const token = "daemon-token";
const fingerprint = "another-checkout-fingerprint";
writeFileSync(daemonRootFile, "/elsewhere/owner-operator");
const daemon = spawn(process.execPath, ["-e", `
  const http = require("node:http");
  const { readFileSync } = require("node:fs");
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer ${token}") { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({
        ok: true, port: ${port}, pid: process.pid, startedAt: "now", fingerprint: "${fingerprint}", stale: false,
        repoRoot: readFileSync(${JSON.stringify(daemonRootFile)}, "utf8"),
      }));
    } else if (request.url === "/ready") {
      response.end(JSON.stringify({ ready: true, setupRequired: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }));
    } else { response.writeHead(404).end(); }
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  server.listen(${port}, "127.0.0.1", () => process.stdout.write("ready\\n"));
`], { stdio: ["ignore", "pipe", "inherit"] });

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const kickstarts = (): number =>
  existsSync(launchLog) ? readFileSync(launchLog, "utf8").split("\n").filter((line) => line.startsWith("kickstart")).length : 0;

try {
  await new Promise<void>((resolve, reject) => {
    daemon.once("error", reject);
    daemon.stdout.once("data", () => resolve());
  });
  process.env.OO_TEST_DAEMON_PID = String(daemon.pid);
  writeFileSync(join(ooHome, "daemon.json"), JSON.stringify({
    port, pid: daemon.pid, startedAt: "now", fingerprint, authToken: token,
  }));

  await ensureDaemon();
  assert.equal(kickstarts(), 0, "a client from another checkout connects instead of restarting the daemon");
  assert.equal(isAlive(daemon.pid!), true, "the other checkout's daemon keeps running");

  writeFileSync(daemonRootFile, repoRoot);
  await ensureDaemon();
  assert.equal(kickstarts(), 1, "a client from the daemon's own checkout still replaces a daemon on older code");

  console.log("ok — only the daemon's own checkout replaces it");
} finally {
  if (daemon.pid && isAlive(daemon.pid)) daemon.kill("SIGTERM");
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

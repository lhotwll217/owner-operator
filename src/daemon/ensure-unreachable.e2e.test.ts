import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} finally {
  child.kill("SIGTERM");
  await once(child, "exit");
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

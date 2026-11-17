import assert from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DaemonInfo, DaemonHealth } from "@owner-operator/core";
import { waitFor } from "../src/gateway/test/helpers";
import { repoRoot } from "../src/shared/repo-root";

const root = realpathSync(mkdtempSync(join(tmpdir(), "oo-pinned-runtime-")));
const home = join(root, "home");
const ooHome = join(home, ".owner-operator");
const bin = join(root, "bin");
const dev = join(root, "dev");
const launchLog = join(root, "launchctl.log");
const prefix = join(root, "npm-prefix");

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
const stub = (name: string, body: string): void => {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
};
// launchd stand-in: it owns only the process it started, and a loaded job whose process exited prints
// `state = not running` as launchctl does. kickstart -k replaces the process with whatever the
// installed plist names; unload stops it.
stub("launchctl", `#!/usr/bin/env node
const { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const args = process.argv.slice(2);
const jobFile = process.env.OO_TEST_JOB_PID;
const loadedFile = jobFile + ".loaded";
appendFileSync(process.env.OO_TEST_LAUNCH_LOG, args.join(" ") + "\\n");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const job = () => { const pid = existsSync(jobFile) ? Number(readFileSync(jobFile, "utf8")) : 0; return pid && alive(pid) ? pid : 0; };
const stop = () => {
  const pid = job();
  if (pid) process.kill(pid, "SIGTERM");
  const until = Date.now() + 5000;
  while (pid && alive(pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  rmSync(jobFile, { force: true });
};
if (args[0] === "print") {
  if (!existsSync(loadedFile)) process.exit(113);
  const pid = job();
  process.stdout.write(pid ? "\\tstate = running\\n\\tpid = " + pid + "\\n" : "\\tstate = not running\\n");
  process.exit(0);
}
if (args[0] === "load" || args[0] === "bootstrap") writeFileSync(loadedFile, "");
if (args[0] === "unload") { stop(); rmSync(loadedFile, { force: true }); }
if (args[0] !== "kickstart") process.exit(0);
if (!existsSync(loadedFile)) process.exit(113);
stop();
const plist = readFileSync(join(process.env.HOME, "Library/LaunchAgents/com.owner-operator.daemon.plist"), "utf8");
const argv = [.../<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/.exec(plist)[1].matchAll(/<string>(.*?)<\\/string>/g)].map((m) => m[1]);
const cwd = /<key>WorkingDirectory<\\/key><string>(.*?)<\\/string>/.exec(plist)[1];
const log = openSync(join(process.env.OO_HOME, "daemon.log"), "a");
const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, env: process.env, stdio: ["ignore", log, log] });
child.unref();
closeSync(log);
writeFileSync(jobFile, String(child.pid));
`);
stub("swift", `#!/bin/sh\nmkdir -p .build/release && touch .build/release/oo-widget\n`);
stub("pkill", "#!/bin/sh\nexit 1\n");
// npm stand-in: `ci` links the repo's installed dependencies and stamps the lockfile like postinstall;
// the global link runs real npm against a temporary prefix.
stub("npm", `#!/bin/sh
[ "$1" = ci ] || exec "$OO_TEST_REAL_NPM" "$@" --offline
mkdir node_modules
for entry in "$OO_TEST_NODE_MODULES"/* "$OO_TEST_NODE_MODULES"/.bin; do ln -s "$entry" node_modules/; done
shasum -a 256 package-lock.json | cut -d" " -f1 > node_modules/.oo-lockfile-sha256
`);

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OO_"))),
  HOME: home,
  OO_HOME: ooHome,
  OO_PORT: String(port),
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  OO_TEST_LAUNCH_LOG: launchLog,
  OO_TEST_JOB_PID: join(root, "launchd-job.pid"),
  OO_TEST_REAL_NPM: execFileSync("which", ["npm"], { encoding: "utf8" }).trim(),
  npm_config_prefix: prefix,
  OO_TEST_NODE_MODULES: join(repoRoot, "node_modules"),
};
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", dev, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();

const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0").filter((path) => path && existsSync(join(repoRoot, path)));
for (const path of tracked) {
  mkdirSync(dirname(join(dev, path)), { recursive: true });
  copyFileSync(join(repoRoot, path), join(dev, path));
}
symlinkSync(join(repoRoot, "node_modules"), join(dev, "node_modules"));
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "dev checkout");
const pinned = git("rev-parse", "HEAD");
const runtime = join(ooHome, "runtime", pinned);

const health = async (): Promise<DaemonHealth> => {
  const info = JSON.parse(readFileSync(join(ooHome, "daemon.json"), "utf8")) as DaemonInfo;
  const response = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { authorization: `Bearer ${info.authToken}` } });
  return await response.json() as DaemonHealth;
};
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const kickstarts = (): number => readFileSync(launchLog, "utf8").split("\n").filter((line) => line.startsWith("kickstart")).length;

const pids: number[] = [];
try {
  const detached = spawn(join(dev, "oo"), ["daemon"], { cwd: dev, env, detached: true, stdio: "ignore" });
  detached.unref();
  pids.push(detached.pid!);
  await waitFor(() => existsSync(join(ooHome, "daemon.json")), 30_000, "a checkout client's detached daemon starts");
  assert.equal((await health()).repoRoot, dev, "before installation a detached daemon serves the dev checkout");

  const install = spawnSync(join(dev, "scripts", "install-runtime.sh"), [], { cwd: dev, env, encoding: "utf8" });
  assert.equal(install.status, 0, `install-runtime.sh failed:\n${install.stdout}\n${install.stderr}`);
  const plist = readFileSync(join(home, "Library", "LaunchAgents", "com.owner-operator.daemon.plist"), "utf8");
  assert.ok(plist.includes(`<string>${runtime}/oo</string>`), "the daemon LaunchAgent runs the pinned runtime");
  const doctor = spawnSync(join(prefix, "bin", "oo"), ["doctor"], { cwd: root, env, encoding: "utf8" });
  assert.ok(doctor.stdout.includes(`Install root: ${runtime}\n`), `the global oo runs the pinned runtime:\n${doctor.stdout}${doctor.stderr}`);

  const before = await health();
  pids.push(before.pid);
  assert.equal(before.repoRoot, runtime, "after installation the pinned runtime's daemon serves");
  assert.equal(alive(detached.pid!), false, "installation retires the checkout's detached daemon");
  const kickstartsAfterInstall = kickstarts();

  appendFileSync(join(dev, "src", "daemon", "ensure.ts"), "\n// edited on a branch\n");
  git("checkout", "-q", "-b", "feature");
  git("commit", "-qam", "branch edit");
  appendFileSync(join(dev, "src", "daemon", "fingerprint.ts"), "\n// uncommitted edit\n");
  const client = spawnSync(join(dev, "oo"), ["session-state", "list", "--json"], { cwd: dev, env, encoding: "utf8" });
  assert.equal(client.status, 0, `dev checkout oo failed:\n${client.stderr}`);
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const after = await health();
  assert.equal(kickstarts(), kickstartsAfterInstall, "a dev checkout client never asks launchd to restart the daemon");
  assert.equal(after.pid, before.pid, "the pinned daemon keeps running across dev edits and branch switches");
  assert.equal(after.fingerprint, before.fingerprint, "the pinned daemon's code is unchanged");
  assert.equal(after.stale, false, "dev edits do not mark the pinned daemon stale");

  appendFileSync(join(runtime, "src", "daemon", "ensure.ts"), "\n// edited in place\n");
  await waitFor(() => !alive(before.pid), 10_000, "an edit inside the runtime itself retires the daemon");

  console.log("ok — dev checkout changes never change or restart the pinned daemon");
} finally {
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGTERM");
  await waitFor(() => !pids.some(alive), 10_000, "test daemons exit").catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

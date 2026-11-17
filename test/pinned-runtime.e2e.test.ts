import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
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
const npmLog = join(root, "npm.log");

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
// launchd stand-in: kickstart stops the discovered daemon and starts whatever the installed plist names.
stub("launchctl", `#!/usr/bin/env node
const { appendFileSync, closeSync, openSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.OO_TEST_LAUNCH_LOG, args.join(" ") + "\\n");
const discovered = () => { try { return JSON.parse(readFileSync(join(process.env.OO_HOME, "daemon.json"), "utf8")).pid; } catch { return undefined; } };
if (args[0] === "print") { const pid = discovered(); if (pid) process.stdout.write("\\tpid = " + pid + "\\n"); process.exit(pid ? 0 : 113); }
if (args[0] !== "kickstart") process.exit(0);
const pid = discovered();
if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
const plist = readFileSync(join(process.env.HOME, "Library/LaunchAgents/com.owner-operator.daemon.plist"), "utf8");
const argv = [.../<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/.exec(plist)[1].matchAll(/<string>(.*?)<\\/string>/g)].map((m) => m[1]);
const cwd = /<key>WorkingDirectory<\\/key><string>(.*?)<\\/string>/.exec(plist)[1];
const log = openSync(join(process.env.OO_HOME, "daemon.log"), "a");
spawn(argv[0], argv.slice(1), { cwd, detached: true, env: process.env, stdio: ["ignore", log, log] }).unref();
closeSync(log);
`);
stub("swift", `#!/bin/sh\nmkdir -p .build/release && touch .build/release/oo-widget\n`);
stub("pkill", "#!/bin/sh\nexit 1\n");
// npm stand-in: `ci` links the repo's installed dependencies and stamps the lockfile like postinstall.
stub("npm", `#!/bin/sh
echo "$*" >> "$OO_TEST_NPM_LOG"
[ "$1" = ci ] || exit 0
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
  OO_TEST_NPM_LOG: npmLog,
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

let daemonPid: number | undefined;
try {
  const install = spawnSync(join(dev, "scripts", "install-runtime.sh"), [], { cwd: dev, env, encoding: "utf8" });
  assert.equal(install.status, 0, `install-runtime.sh failed:\n${install.stdout}\n${install.stderr}`);
  const plist = readFileSync(join(home, "Library", "LaunchAgents", "com.owner-operator.daemon.plist"), "utf8");
  assert.ok(plist.includes(`<string>${runtime}/oo</string>`), "the daemon LaunchAgent runs the pinned runtime");
  assert.ok(readFileSync(npmLog, "utf8").includes(`install -g --ignore-scripts --no-audit --no-fund ${runtime}`), "the global oo links to the pinned runtime");

  await waitFor(() => existsSync(join(ooHome, "daemon.json")), 30_000, "launchd starts the pinned daemon");
  const before = await health();
  daemonPid = before.pid;
  assert.equal(before.repoRoot, runtime, "the live daemon serves the pinned runtime's code");
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
  if (daemonPid && alive(daemonPid)) process.kill(daemonPid, "SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

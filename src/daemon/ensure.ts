import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { connectGateway, probeGateway } from "../gateway/client";
import { daemonLogPath, ownerOperatorHome } from "../shared/paths";
import { repoRoot } from "../shared/repo-root";
import { runtimeFingerprint } from "./fingerprint";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const DAEMON_LABEL = "com.owner-operator.daemon";
const LAUNCHCTL_NOT_LOADED_CODES = new Set<string | number>([3, 113]);
const daemonLaunchAgentPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
// launchd owns only the default per-user home. An explicitly spelled default is still the
// installed job's home; true sandboxes/custom homes must manage their own daemon.
const launchdCanManageCurrentHome = (): boolean =>
  resolve(ownerOperatorHome()) === resolve(join(homedir(), ".owner-operator"));

enum LaunchdPidOwnership {
  Owned = "owned",
  NotOwned = "not-owned",
  Unknown = "unknown",
}

async function loopbackPortIsFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function launchdPidOwnership(pid: number): Promise<LaunchdPidOwnership> {
  const uid = process.getuid?.();
  if (uid === undefined) return LaunchdPidOwnership.Unknown;
  try {
    const { stdout } = await execFileAsync(
      "launchctl",
      ["print", `gui/${uid}/${DAEMON_LABEL}`],
      { encoding: "utf8" },
    );
    const reportedPid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout)?.[1];
    if (!reportedPid) return LaunchdPidOwnership.Unknown;
    return Number(reportedPid) === pid ? LaunchdPidOwnership.Owned : LaunchdPidOwnership.NotOwned;
  } catch (error) {
    const code = (error as Error & { code?: string | number }).code;
    return code !== undefined && LAUNCHCTL_NOT_LOADED_CODES.has(code)
      ? LaunchdPidOwnership.NotOwned
      : LaunchdPidOwnership.Unknown;
  }
}

async function startDaemonProcess(): Promise<void> {
  const launchAgent = daemonLaunchAgentPath();
  if (launchdCanManageCurrentHome() && existsSync(launchAgent)) {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("installed daemon LaunchAgent requires a Unix user id");
    const domain = `gui/${uid}`;
    const target = `${domain}/${DAEMON_LABEL}`;
    await execFileAsync("launchctl", ["enable", target]);
    try {
      await execFileAsync("launchctl", ["kickstart", "-k", target]);
    } catch (error) {
      const code = (error as Error & { code?: string | number }).code;
      if (code === undefined || !LAUNCHCTL_NOT_LOADED_CODES.has(code)) throw error;
      await execFileAsync("launchctl", ["bootstrap", domain, launchAgent]);
      await execFileAsync("launchctl", ["kickstart", "-k", target]);
    }
    return;
  }

  mkdirSync(ownerOperatorHome(), { recursive: true });
  const log = openSync(daemonLogPath(), "a");
  const child = spawn(`${repoRoot}/oo`, ["daemon"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
}

/** Ensure a ready daemon for terminal clients; the widget remains a pure client. */
export async function ensureDaemon(): Promise<void> {
  const expected = runtimeFingerprint();
  const existing = await probeGateway();
  const launchdOwnsDaemon = launchdCanManageCurrentHome() && existsSync(daemonLaunchAgentPath());
  let startRequested = false;
  if (existing) {
    if (existing.health.fingerprint === expected && !existing.health.stale && existing.ready.ready) return;
    const ownership = launchdOwnsDaemon
      ? await launchdPidOwnership(existing.health.pid)
      : LaunchdPidOwnership.NotOwned;
    if (ownership === LaunchdPidOwnership.Unknown) {
      throw new Error(`could not verify launchd ownership of daemon pid ${existing.health.pid}`);
    }
    if (ownership === LaunchdPidOwnership.Owned) {
      await startDaemonProcess();
      startRequested = true;
    } else {
      try { process.kill(existing.health.pid, "SIGTERM"); } catch { /* already gone */ }
      let released = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const current = await probeGateway();
        if (
          current && current.health.pid !== existing.health.pid &&
          current.health.fingerprint === expected && !current.health.stale && current.ready.ready
        ) return;
        if (!current && await loopbackPortIsFree(existing.info.port)) {
          released = true;
          break;
        }
        await sleep(100);
      }
      if (!released) {
        throw new Error(
          `Owner Operator daemon pid ${existing.health.pid} did not release port ${existing.info.port}`,
        );
      }
    }
  }

  if (!startRequested) await startDaemonProcess();

  let gateway;
  for (let attempt = 0; attempt < 40; attempt++) {
    gateway = await connectGateway();
    if (gateway) { gateway.close(); return; }
    await sleep(125);
  }
  throw new Error(`Owner Operator daemon did not become ready; inspect ${daemonLogPath()}`);
}

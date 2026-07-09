import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { connectGateway } from "../gateway/client";
import { daemonLogPath, ownerOperatorHome } from "../shared/paths";
import { repoRoot } from "../shared/repo-root";
import { runtimeFingerprint } from "./fingerprint";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ensure a ready daemon for terminal clients; the widget remains a pure client. */
export async function ensureDaemon(): Promise<void> {
  const expected = runtimeFingerprint();
  let gateway = await connectGateway();
  if (gateway) {
    const health = await gateway.health();
    gateway.close();
    if (health.fingerprint === expected && !health.stale) return;
    try { process.kill(health.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let attempt = 0; attempt < 20; attempt++) {
      const old = await connectGateway();
      if (!old) break;
      old.close();
      await sleep(100);
    }
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

  for (let attempt = 0; attempt < 40; attempt++) {
    gateway = await connectGateway();
    if (gateway) { gateway.close(); return; }
    await sleep(125);
  }
  throw new Error(`Owner Operator daemon did not become ready; inspect ${daemonLogPath()}`);
}

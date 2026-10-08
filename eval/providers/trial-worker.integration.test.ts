import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTrialWorker } from "./trial-worker.mjs";

const temp = mkdtempSync(join(tmpdir(), "oo-trial-worker-"));
const loader = fileURLToPath(import.meta.resolve("tsx"));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const options = { cwd: temp, env: process.env, loader, killGraceMs: 500 };

/** A worker that starts an agent and then behaves as `mode` says. The agent ignores SIGTERM and
 *  inherits stdout, so only group-wide cleanup can stop it and only a drain can settle the pipe. */
function stubbornWorker(name: string, mode: "linger" | "exit" | "crash") {
  const script = join(temp, `${name}.mjs`);
  const marker = join(temp, `${name}.json`);
  writeFileSync(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const agent = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ worker: process.pid, agent: agent.pid }));
${mode === "linger" ? "setInterval(() => {}, 1000);" : ""}
${mode === "exit" ? "setTimeout(() => process.exit(0), 300);" : ""}
${mode === "crash" ? "setTimeout(() => process.exit(9), 300);" : ""}
`);
  return { script, marker, pids: () => JSON.parse(readFileSync(marker, "utf8")) };
}

try {
  // The sample's own timeout: the worker ignores SIGTERM and its agent holds the pipe open.
  const lingering = stubbornWorker("linger", "linger");
  let started = Date.now();
  const timedOut = await spawnTrialWorker(lingering.script, { probe: true }, options, 1_000);
  assert.equal(timedOut.timedOut, true, "the stubborn worker timed out");
  assert.equal(timedOut.orphaned, false, timedOut.spawnError ?? "the group was reaped");
  assert.ok(Date.now() - started < 60_000, "settled without waiting on the inherited pipe");
  let pids = lingering.pids();
  assert.equal(alive(pids.worker), false, "the worker is gone");
  assert.equal(alive(pids.agent), false, "the agent the worker owned is gone, not reparented");

  // The worker exits first and leaves its agent running. Nothing timed out and nothing was
  // interrupted, so this is a broken sample: the leftover is killed and the run is invalid.
  const exiting = stubbornWorker("exit", "exit");
  const leftover = await spawnTrialWorker(exiting.script, { probe: true }, options, 600_000);
  assert.equal(leftover.timedOut, false);
  assert.equal(leftover.interrupted, false);
  assert.equal(leftover.leftovers, true, "the agent outliving the worker is noticed");
  assert.equal(leftover.orphaned, false);
  assert.match(leftover.spawnError, /left a live descendant behind/, "a leftover invalidates the sample");
  pids = exiting.pids();
  assert.equal(alive(pids.agent), false, "the leftover agent was cleaned up");

  // A crashing worker is held to the same cleanup, and its exit code still surfaces.
  const crashing = stubbornWorker("crash", "crash");
  const crashed = await spawnTrialWorker(crashing.script, { probe: true }, options, 600_000);
  assert.equal(crashed.leftovers, true);
  assert.match(crashed.spawnError, /trial worker exited 9/);
  assert.match(crashed.spawnError, /left a live descendant behind/);
  assert.equal(alive(crashing.pids().agent), false);

  // An interrupt escalates on its own clock rather than waiting out a ten-minute sample timeout.
  const interrupted = stubbornWorker("interrupt", "linger");
  started = Date.now();
  const pending = spawnTrialWorker(interrupted.script, { probe: true }, options, 600_000);
  for (let attempt = 0; attempt < 300 && !existsSync(interrupted.marker); attempt++) {
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(existsSync(interrupted.marker), "the worker started its agent before the interrupt");
  process.emit("SIGINT");
  const stopped = await pending;
  assert.ok(Date.now() - started < 60_000, "the interrupt did not wait for the sample timeout");
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.orphaned, false, stopped.spawnError ?? "the group was reaped");
  pids = interrupted.pids();
  assert.equal(alive(pids.worker), false, "the worker stopped on the interrupt");
  assert.equal(alive(pids.agent), false, "the agent it owned stopped with it");

  // A worker that finishes on its own reports its output and a clean ending.
  const quick = join(temp, "quick-worker.mjs");
  writeFileSync(quick, `process.stdout.write("OO_PROBE=" + process.argv[2] + "\\n");\n`);
  const ok = await spawnTrialWorker(quick, { probe: "value" }, options, 30_000);
  assert.equal(ok.spawnError, null);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.leftovers, false);
  assert.equal(ok.orphaned, false);
  assert.deepEqual(JSON.parse(Buffer.from(/OO_PROBE=(\S+)/.exec(ok.stdout)![1], "base64url").toString("utf8")),
    { probe: "value" }, "the worker receives its input as one base64url argument");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("trial worker: no agent outlives its sample on timeout, early exit, crash, or interrupt");

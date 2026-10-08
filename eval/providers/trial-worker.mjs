// One trial worker process, for the eval profiles that give each sample its own sandbox user.
//
// The worker leads its own process group, so a stubborn descendant cannot outlive the sample: a
// child agent is a grandchild here, and signalling the worker alone leaves it running and holding
// the inherited stdout pipe, which then never closes. Escalation therefore signals the group, the
// group is checked however the worker ended, and a sample that left anything behind is reported as
// a broken instrument rather than a result. An interrupt is forwarded to the group and escalates on
// its own clock instead of waiting out the sample's timeout.
import { spawn } from "node:child_process";

const SIGKILL_GRACE_MS = 15_000;
const PIPE_DRAIN_MS = 2_000;
const REAP_POLL_MS = 100;
const REAP_ATTEMPTS = 50;
const SETTLE_GRACE_ATTEMPTS = 5;

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** Run `script` with `input` as one base64url argument. Resolves with the worker's output and how
 *  it ended: `timedOut`, `interrupted`, `leftovers` when the group outlived the worker, and
 *  `orphaned` when it outlived SIGKILL. */
export function spawnTrialWorker(script, input, { cwd, env, loader, killGraceMs = SIGKILL_GRACE_MS }, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      "--import", loader, script, Buffer.from(JSON.stringify(input)).toString("base64url"),
    ], { cwd, env, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let spawnError = null;
    let settled = false;
    let killTimer = null;
    let drainTimer = null;

    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") spawnError ??= String(error); }
    };
    const groupAlive = () => {
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return error.code !== "ESRCH"; }
    };
    const groupExited = async (attempts) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (!groupAlive()) return true;
        await delay(REAP_POLL_MS);
      }
      return !groupAlive();
    };
    // Stopping starts its own kill clock, so an interrupt never waits out the sample's timeout.
    const stop = (signal) => {
      signalGroup(signal);
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
    };
    const forward = (signal) => () => {
      interrupted = true;
      clearTimeout(timer);
      stop(signal);
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);

    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
    }, timeoutMs + 5_000);

    const settle = async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
      // However the worker ended, its group has to be empty. A short grace absorbs the worker's
      // own teardown; anything still alive after it is a descendant the sample failed to stop.
      const leftovers = !await groupExited(SETTLE_GRACE_ATTEMPTS);
      if (leftovers) signalGroup("SIGKILL");
      const orphaned = leftovers && !await groupExited(REAP_ATTEMPTS);
      clearTimeout(killTimer);
      if (code !== 0 && !spawnError) spawnError = `trial worker exited ${code ?? signal ?? "unknown"}`;
      if (leftovers && !timedOut && !interrupted) {
        spawnError = [spawnError, "trial worker left a live descendant behind"].filter(Boolean).join("; ");
      }
      if (orphaned) {
        spawnError = [spawnError, "trial worker process group outlived SIGKILL"].filter(Boolean).join("; ");
      }
      resolvePromise({ stdout, stderr, timedOut, interrupted, leftovers, orphaned, spawnError });
    };

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = String(error); });
    // `close` waits for every inherited pipe writer. A surviving grandchild holds one open, so the
    // worker's own exit starts a bounded drain and settles even if the pipe never closes.
    child.once("close", (code, signal) => { void settle(code, signal); });
    child.once("exit", (code, signal) => {
      drainTimer = setTimeout(() => { void settle(code, signal); }, PIPE_DRAIN_MS);
    });
  });
}

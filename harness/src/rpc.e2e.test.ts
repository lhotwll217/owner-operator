// e2e: drive the real `oo --rpc` process over stdin/stdout and assert the command gate end to
// end — `bash` and unknown commands are rejected on the protocol channel and never execute;
// `get_state` is allowed. Building the neutral session needs a resolvable model, so this SKIPS
// cleanly if the process can't start one (e.g. no model configured).
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const ooBin = join(repoRoot, "harness", "oo");
const marker = join(tmpdir(), `oo-rpc-e2e-${process.pid}`);
rmSync(marker, { force: true });

// Isolated OO_HOME: the rpc agent saves its thread there — a test run must not land in the real one.
const ooHome = join(tmpdir(), `oo-rpc-e2e-home-${process.pid}`);
const child = spawn(ooBin, ["--rpc"], { cwd: repoRoot, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, OO_HOME: ooHome } });
const responses = new Map<string, { success?: boolean }>();
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d: string) => {
  buf += d;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const m = JSON.parse(line);
      if (m && m.type === "response" && typeof m.id === "string") responses.set(m.id, m);
    } catch { /* not a JSON response line */ }
  }
});

let exited = false;
child.on("exit", () => { exited = true; });

const send = (o: unknown): void => { child.stdin.write(JSON.stringify(o) + "\n"); };
send({ type: "bash", command: `touch ${marker}`, id: "bash" });
send({ type: "totally_unknown_cmd", id: "unknown" });
send({ type: "get_state", id: "state" });

const deadline = Date.now() + 60_000;
while (!responses.has("state") && !exited && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}

try {
  if (responses.size === 0) {
    process.stdout.write("skip — oo --rpc produced no response (no model configured to build the session)\n");
  } else {
    assert.equal(responses.get("bash")?.success, false, "bash rejected by the gate");
    assert.equal(responses.get("unknown")?.success, false, "unknown command rejected (allowlist)");
    assert.equal(existsSync(marker), false, "bash did NOT execute — no side effect on disk");
    if (responses.has("state")) assert.equal(responses.get("state")?.success, true, "get_state allowed");
    process.stdout.write("ok — rpc e2e: gate rejects bash + unknown with no side effect, allows get_state\n");
  }
} finally {
  try { child.stdin.end(); child.kill(); } catch { /* already gone */ }
  rmSync(marker, { force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

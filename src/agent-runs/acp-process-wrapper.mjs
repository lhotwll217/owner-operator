#!/usr/bin/env node
// Stable process-tree root for delegated ACP agents. The daemon puts a durable lease id on this
// command line before spawn; startup cleanup can therefore prove ownership without claiming an
// unrelated acpx/Claude/Codex process after PID reuse.
import { spawn } from "node:child_process";

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const leaseId = valueAfter("--oo-agent-run-lease");
const encodedCommand = valueAfter("--oo-agent-command");
if (!leaseId || !encodedCommand) {
  process.stderr.write("owner-operator ACP wrapper: missing process lease or agent command\n");
  process.exit(2);
}

const agentCommand = Buffer.from(encodedCommand, "base64url").toString("utf8");
const child = spawn(agentCommand, {
  shell: true,
  detached: process.platform !== "win32",
  stdio: "inherit",
  env: { ...process.env, OO_AGENT_RUN_LEASE_ID: leaseId },
});

const forward = (signal) => {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    // The child tree may already be gone.
  }
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => forward(signal));
}

child.once("error", (error) => {
  process.stderr.write(`owner-operator ACP wrapper: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

// Owner Operator — headless JSON-RPC entry (`oo --rpc`). A thin SUPERVISOR: it owns the caller's
// stdin/stdout, enforces the read-only command allowlist (rpc-gate), and proxies vetted commands
// to a child process that runs pi's full RPC agent (rpc-agent.ts). The security boundary is a real
// process/pipe boundary — blocked commands never reach the pi agent's stdin — instead of swapping
// this process's own streams. See issue #12 for why we moved off the in-process interpose.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRpcLine } from "./rpc-gate";

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, "..", "oo"); // reuse the launcher's tsx setup to run the child entry

const child = spawn(launcher, ["__rpc-agent"], { stdio: ["pipe", "pipe", "inherit"] });
child.stdout.pipe(process.stdout); // the pi agent's protocol output → caller, untouched
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  process.stderr.write(`[oo --rpc] could not start the agent: ${e.message}\n`);
  process.exit(1);
});

// Read the caller's stdin, LF-framed (pi's JSONL). Forward only allowlisted commands to the child;
// reject the rest ourselves. We do NOT run runRpcMode here, so process.stdout is ours to write to.
process.stdin.setEncoding("utf8");
let buf = "";
const handleLine = (line: string): void => {
  if (!line) return;
  const decision = classifyRpcLine(line);
  if (decision.forward) child.stdin.write(line + "\n");
  else process.stdout.write(decision.response + "\n");
};
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    handleLine(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
  }
});
process.stdin.on("end", () => {
  handleLine(buf);
  buf = "";
  child.stdin.end(); // → child's runRpcMode sees EOF → exits → our exit handler fires
});

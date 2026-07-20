import assert from "node:assert";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const wrapperPath = fileURLToPath(new URL("./acp-process-wrapper.mjs", import.meta.url));
const leaseId = "11111111-1111-4111-8111-111111111111";
const isolatedHome = mkdtempSync(join(tmpdir(), "oo-acp-wrapper-"));
const echoCommand = [
  JSON.stringify(process.execPath),
  "-e",
  JSON.stringify("process.stdin.pipe(process.stdout)"),
].join(" ");
try {
  const child = spawn(process.execPath, [
    wrapperPath,
    "--oo-agent-run-lease",
    leaseId,
    "--oo-agent-command",
    Buffer.from(echoCommand).toString("base64url"),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: isolatedHome, OO_HOME: isolatedHome },
  });

  assert.ok(child.pid);
  if (process.platform !== "win32") {
    const liveCommand = execFileSync("ps", ["-p", String(child.pid), "-o", "command="], {
      encoding: "utf8",
    });
    assert.match(liveCommand, new RegExp(leaseId), "the live wrapper command carries its lease id");
    assert.ok(liveCommand.includes(wrapperPath), "the live process has the exact owned wrapper path");
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end("ACP pipe stays transparent\n");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(stdout, "ACP pipe stays transparent\n");
  process.stdout.write("ok — leased ACP wrapper preserves stdio and exposes verifiable ownership\n");
} finally {
  rmSync(isolatedHome, { recursive: true, force: true });
}

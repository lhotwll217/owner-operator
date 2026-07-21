import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

interface RenderInRealPtyOptions {
  command: string;
  width: number;
  env: Record<string, string>;
  label: string;
  timeoutMs?: number;
}

/** Run a self-rendering fixture in a real PTY and return its BEGIN/END transcript body. */
export async function renderInRealPty(options: RenderInRealPtyOptions): Promise<string[]> {
  const scriptCommand = process.platform === "darwin"
    ? `/usr/bin/script -q /dev/null /bin/sh -c '${options.command}'`
    : `/usr/bin/script -q -e -c '${options.command}' /dev/null`;
  // macOS `script` requires an anonymous pipe (not Node's socket-backed "pipe") as stdin.
  const child = spawn("/bin/sh", ["-c", `(while printf '\\0'; do sleep 1; done) |\n${scriptCommand}`], {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      reject(new Error(`${options.label} timed out at ${options.width} columns`));
    }, options.timeoutMs ?? 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(status, 0, `${options.label} exits cleanly: ${stderr}\n${stdout}`);
  const plain = stripVTControlCharacters(stdout).replaceAll("\r", "");
  assert.match(plain, new RegExp(`TTY=true COLS=${options.width}`));
  const body = plain.match(/BEGIN\n([\s\S]*?)\nEND/)?.[1];
  assert.ok(body !== undefined, `${options.label} output has render markers: ${plain}`);
  return body.split("\n");
}

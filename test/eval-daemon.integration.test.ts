import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../src/gateway/test/helpers";

const dir = mkdtempSync(join(tmpdir(), "oo-eval-daemon-"));
const discovery = join(dir, "daemon.json");
writeFileSync(join(dir, "session_sources.json"), JSON.stringify({
  disable: ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"],
  add: [],
}));

const child = spawn(process.execPath, ["--import", "tsx", "eval/providers/eval-daemon.mjs"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, OO_HOME: dir },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
let stdout = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  await waitFor(
    () => existsSync(discovery) && stdout.includes("[oo-eval-daemon] ready"),
    2_000,
    `eval daemon readiness (${stderr})`,
  );
  child.kill("SIGTERM");
  const exit = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  assert.equal(exit, 0, `managed eval daemon exits cleanly: ${stderr}`);
  assert.equal(existsSync(discovery), false, "managed eval daemon removes discovery on shutdown");
  process.stdout.write("ok — managed eval daemon lifecycle\n");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

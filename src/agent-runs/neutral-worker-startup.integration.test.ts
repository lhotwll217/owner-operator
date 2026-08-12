import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { absoluteTsxLoaderPath } from "../shared/tsx-loader";

if (process.env.OO_NEUTRAL_TSX_WORKER === "1") {
  process.stdout.write(`ready:${process.cwd()}\n`);
  process.exit(0);
}

const neutral = realpathSync(mkdtempSync(join(tmpdir(), "oo-neutral-worker-")));
try {
  const entry = fileURLToPath(import.meta.url);
  const loader = absoluteTsxLoaderPath();
  assert.ok(loader.startsWith("/"), "the tsx loader is absolute");
  const child = spawn(process.execPath, ["--import", loader, entry], {
    cwd: neutral,
    env: { ...process.env, OO_NEUTRAL_TSX_WORKER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), `ready:${neutral}`, "the TypeScript worker starts outside the repository cwd");
} finally {
  rmSync(neutral, { recursive: true, force: true });
}

process.stdout.write("ok — live-worker TypeScript entry resolves from a neutral cwd without provider calls\n");

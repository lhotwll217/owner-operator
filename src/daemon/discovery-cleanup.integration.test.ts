import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./runtime";

const root = mkdtempSync(join(tmpdir(), "oo-discovery-cleanup-"));
const oldEnv = { HOME: process.env.HOME, OO_HOME: process.env.OO_HOME };
process.env.HOME = join(root, "home");
process.env.OO_HOME = join(root, "oo");
mkdirSync(process.env.HOME);
const discovery = join(process.env.OO_HOME, "daemon.json");
try {
  for (const changed of ["pid", "startedAt", "neither"]) {
    const daemon = await startDaemon({
      port: 0,
      watch: false,
      enableEnrichment: false,
      monitor: { scan: async () => [], intervalMs: 60_000 },
    });
    try {
      const info = JSON.parse(readFileSync(discovery, "utf8"));
      if (changed === "pid") info.pid += 1;
      if (changed === "startedAt") info.startedAt = "another-incarnation";
      writeFileSync(discovery, JSON.stringify(info));
    } finally {
      await daemon.close();
    }
    assert.equal(existsSync(discovery), changed !== "neither", `cleanup checks both identity fields; changed ${changed}`);
  }
  console.log("ok - discovery cleanup requires both PID and start time to match");
} finally {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

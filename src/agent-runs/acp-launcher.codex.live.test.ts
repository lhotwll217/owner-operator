// Paid startup acceptance: fake-runtime tests cannot catch a real Codex adapter/CLI handshake break.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRunHarness,
  AgentRunStatus,
  type AgentRun,
  type AgentRunLaunchResult,
} from "@owner-operator/core";

const EXPECTED = "OO_CODEX_ACP_LIVE_OK";

if (process.env.OO_CODEX_ACP_LIVE_WORKER === "1") {
  const { createAcpLauncher } = await import("./acp-launcher");
  const now = new Date().toISOString();
  const run: AgentRun = {
    id: crypto.randomUUID(),
    harness: AgentRunHarness.Codex,
    task: `Reply with exactly ${EXPECTED}. Do not use tools.`,
    cwd: process.cwd(),
    parentThreadId: "codex-live-acceptance",
    model: process.env.OO_CODEX_ACP_LIVE_MODEL?.trim() || null,
    effort: "high",
    effortApplied: false,
    depth: 1,
    status: AgentRunStatus.Running,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    activity: null,
    lastActivityAt: null,
    childSessionId: null,
    acpxRecordId: null,
    resultTail: null,
    error: null,
    resumeOfRunId: null,
    timeoutSeconds: 180,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Codex live acceptance timed out")), 180_000);
  timeout.unref?.();
  try {
    const result = await createAcpLauncher()({
      run,
      resumeSessionId: null,
      signal: controller.signal,
      onActivity: () => undefined,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.status === AgentRunStatus.Completed ? 0 : 1);
  } finally {
    clearTimeout(timeout);
  }
}

if (process.env.OO_RUN_LIVE_CODEX_ACP_TEST !== "1") {
  process.stdout.write("skip — set OO_RUN_LIVE_CODEX_ACP_TEST=1 to run the paid Codex ACP startup acceptance\n");
  process.exit(0);
}

const root = process.cwd();
const testPath = fileURLToPath(import.meta.url);
const ooHome = mkdtempSync(join(tmpdir(), "oo-codex-acp-live-"));
try {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", testPath],
    {
      cwd: root,
      env: {
        ...process.env,
        OO_HOME: ooHome,
        OO_CODEX_ACP_LIVE_WORKER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Codex ACP worker exceeded its 200s outer deadline\n${stderr}`));
    }, 200_000);
    deadline.unref?.();
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal });
    });
  });
  assert.equal(exit.signal, null, `Codex ACP worker was killed: ${exit.signal ?? ""}\n${stderr}`);
  assert.equal(exit.code, 0, `Codex ACP startup failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line, "Codex ACP worker returned no result");
  const result = JSON.parse(line) as AgentRunLaunchResult;
  assert.equal(result.status, AgentRunStatus.Completed);
  assert.ok(result.childSessionId, "real Codex startup publishes a child session identity");
  assert.match(result.resultText, new RegExp(EXPECTED));
  process.stdout.write("ok — real Codex ACP adapter initializes and completes one turn\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

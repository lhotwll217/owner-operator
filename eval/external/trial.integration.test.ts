import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import gradeTrajectory from "../asserts/tool-use.mjs";
import { evalSandboxPath } from "../sandbox.mjs";
import { runExternalTrial, SETTLED_SESSION_ID } from "./trial.mjs";

const run = promisify(execFile);
const temp = mkdtempSync(join(tmpdir(), "oo-external-trial-"));
const credential = join(temp, "auth.json");
writeFileSync(credential, JSON.stringify({ access_token: "synthetic-credential-must-not-escape" }));
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const before = process.env.HOME;
const grade = (metadata: object, testMetadata: object) =>
  gradeTrajectory("", { test: { metadata: { profile: "external", ...testMetadata } }, providerResponse: { metadata } });

try {
  // A controlled agent drives the real launcher, CLI, daemon, and fixture state.
  const root = evalSandboxPath(randomUUID());
  const sessionId = randomUUID();
  const response = await runExternalTrial({ root, checkout, harness: "codex", model: "controlled-model", effort: "high",
    executable: "/controlled/codex", credentialSource: credential, prompt: "Find the quasar-api 429 cause.", timeoutMs: 30_000,
  }, async (_id: string, options: { options: { config: Record<string, any> } }) => {
    const config = options.options.config;
    assert.equal(config.inherit_process_env, false);
    assert.notEqual(config.cli_env.HOME, before);
    assert.equal(config.cli_env.CODEX_THREAD_ID, undefined, "the parent session must not leak");
    return { async callApi(prompt: string) {
      assert.ok(prompt.includes("<skill name=\"owner-operator\">"));
      assert.ok(!prompt.includes("llm-rubric") && !prompt.includes("RateLimiter.refill() interpreted"), "grading stays outside the subject's context");
      const env = { ...config.cli_env, CODEX_THREAD_ID: sessionId };
      const oo = join(root, "bin/oo");
      const shell = env.SHELL || "/bin/sh";
      assert.equal((await run(shell, ["-lc", "command -v oo"], { env })).stdout.trim(), oo, "login shell keeps the launcher");
      await run(shell, ["-lc", "oo --help"], { env });
      const query = await run(oo, ["search", "--query", "429", "--json"], { env });
      assert.ok(!query.stdout.includes("Cobalt DNS cache"), "the real caller is excluded from discovery");
      const wrong = await run(oo, ["search", "--query", "429", "--from-session", "none", "--json"], { env });
      assert.ok(wrong.stdout.includes("Cobalt DNS cache"), "a wrong caller exposes the planted transcript");
      const settled = await run(oo, ["db", "query", "SELECT thread_id, topic FROM thread_details WHERE topic LIKE '%42%'", "--json"], { env });
      assert.ok(settled.stdout.includes(SETTLED_SESSION_ID), "the settling session is in the real index");
      return { output: "synthetic-credential-must-not-escape", sessionId, raw: JSON.stringify({ items: [] }) };
    } };
  });
  const metadata = response.metadata;
  assert.equal(metadata.harnessValid, true, JSON.stringify(response));
  assert.equal(metadata.cliCalls.length, 4);
  assert.ok(!JSON.stringify(response).includes("synthetic-credential-must-not-escape"), "credential values are scrubbed");
  assert.equal(process.env.HOME, before);
  assert.equal(existsSync(root), false, "verified teardown removes the sandbox");
  assert.equal(existsSync(`${root}.settings`), false);

  // Grading: evidence and identity, with routes only where a case names them.
  const [, , wrongCaller, settled] = metadata.cliCalls;
  const leaked = grade(metadata, { excludeCallerTranscript: true });
  assert.equal(leaked.pass, false, "a call made under the wrong caller fails");
  assert.match(leaked.reason, /caller identity|caller's own transcript/);
  const honest = { ...metadata, cliCalls: metadata.cliCalls.filter((call: object) => call !== wrongCaller) };
  assert.equal(grade(honest, { excludeCallerTranscript: true }).pass, true, grade(honest, {}).reason);
  assert.equal(grade(honest, { requireEvidenceFrom: SETTLED_SESSION_ID }).pass, true);
  const constant = { ...settled, args: ["db", "query", "SELECT 42 FROM thread_details"], output: "42" };
  assert.equal(grade({ ...honest, cliCalls: [honest.cliCalls[1], constant] }, { requireEvidenceFrom: SETTLED_SESSION_ID }).pass, false,
    "a query that never returns the settling session is not evidence");
  assert.equal(grade(honest, { indexBeforeTranscript: true }).pass, false, "the index query came after the transcript search");
  assert.equal(grade({ ...honest, cliCalls: [settled, honest.cliCalls[1]] }, { indexBeforeTranscript: true }).pass, true);
  assert.equal(grade({ ...honest, harnessValid: false }, {}).pass, false);

  // A failed start still closes the daemon and removes the copied credential.
  const failedRoot = evalSandboxPath(randomUUID());
  const failed = await runExternalTrial({ root: failedRoot, checkout, harness: "claude-code", model: "controlled-model", effort: "high",
    executable: "/controlled/claude", credentialSource: credential, prompt: "Find a session.", timeoutMs: 30_000,
  }, async () => { throw new Error("controlled startup failure"); });
  assert.equal(failed.metadata.harnessValid, false);
  assert.equal(existsSync(failedRoot), false);

  // An interrupt reaches the worker; the native Codex provider stops its executable and the
  // sandbox and copied credential are removed.
  const marker = join(temp, "started.json");
  const executable = join(temp, "codex");
  writeFileSync(executable, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, home: process.env.HOME }));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const interruptedRoot = evalSandboxPath(randomUUID());
  const input = { root: interruptedRoot, checkout, harness: "codex", model: "controlled-model", effort: "medium",
    executable, credentialSource: credential, prompt: "Find a session.", timeoutMs: 60_000 };
  const worker = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./trial.mjs", import.meta.url)),
    Buffer.from(JSON.stringify(input)).toString("base64url")], { stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  worker.stdout.on("data", (chunk) => { stdout += chunk; });
  const exited = new Promise((resolve) => worker.once("close", resolve));
  for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt++) await new Promise((done) => setTimeout(done, 100));
  assert.ok(existsSync(marker), "the controlled executable started");
  const started = JSON.parse(readFileSync(marker, "utf8"));
  worker.kill("SIGINT");
  await exited;
  const result = JSON.parse(Buffer.from(/^OO_EXTERNAL_RESULT=(\S+)$/m.exec(stdout)![1], "base64url").toString("utf8"));
  assert.equal(result.metadata.harnessValid, false);
  assert.match(result.metadata.harnessProblems.join(" "), /SIGINT|abort/i);
  assert.equal(existsSync(started.home), false, "sandbox and copied credential removed after the interrupt");
  await new Promise((done) => setTimeout(done, 500));
  assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" }, "the agent executable stopped");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log("external trial: isolation, real CLI evidence, caller exclusion, redaction, grading, teardown, interrupt");

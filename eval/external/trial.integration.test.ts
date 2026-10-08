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
const base = {
  checkout, harness: "codex", model: "controlled-model", effort: "high",
  executable: "/controlled/codex", credentialSource: credential, timeoutMs: 30_000,
};
/** The behavior gate exactly as Promptfoo calls it for an external subject. */
const grade = (metadata: object, testMetadata: object) => gradeTrajectory("", {
  provider: { label: "external-codex" },
  test: { metadata: testMetadata },
  providerResponse: { metadata },
});

try {
  // A controlled agent drives the real launcher, CLI, daemon, and fixture state.
  const root = evalSandboxPath(randomUUID());
  const sessionId = randomUUID();
  const response = await runExternalTrial({
    ...base, root, settledObligation: true, prompt: "Find the quasar-api 429 cause.",
  }, async (_id: string, options: { options: { config: Record<string, any> } }) => {
    const config = options.options.config;
    assert.equal(config.inherit_process_env, false);
    assert.notEqual(config.cli_env.HOME, before);
    assert.equal(config.cli_env.CODEX_THREAD_ID, undefined, "the parent session must not leak");
    return { async callApi(prompt: string) {
      assert.ok(prompt.includes("<skill name=\"owner-operator\">"));
      assert.ok(!prompt.includes("llm-rubric") && !prompt.includes("RateLimiter.refill() interpreted"),
        "grading expectations stay outside the subject's context");
      const env = { ...config.cli_env, CODEX_THREAD_ID: sessionId };
      const oo = join(root, "bin/oo");
      const shell = env.SHELL || "/bin/sh";
      assert.equal((await run(shell, ["-lc", "command -v oo"], { env })).stdout.trim(), oo, "login shell keeps the launcher");
      await run(shell, ["-lc", "oo --help"], { env });
      const index = await run(oo, ["db", "query", "SELECT thread_id, topic FROM thread_details WHERE topic LIKE '%42%'", "--json"], { env });
      assert.ok(index.stdout.includes(SETTLED_SESSION_ID), "the opted-in settling session is in the real index");
      const query = await run(oo, ["search", "--query", "429", "--json"], { env });
      assert.ok(!query.stdout.includes("Cobalt DNS cache"), "the real caller is excluded from discovery");
      const wrong = await run(oo, ["search", "--query", "429", "--from-session", "none", "--json"], { env });
      assert.ok(wrong.stdout.includes("Cobalt DNS cache"), "a wrong caller exposes the planted transcript");
      return { output: "synthetic-credential-must-not-escape", sessionId, raw: JSON.stringify({ items: [] }) };
    } };
  });
  const metadata = response.metadata;
  assert.equal(metadata.harnessValid, true, JSON.stringify(response));
  assert.equal(metadata.ooCalls.length, 4);
  assert.ok(!JSON.stringify(response).includes("synthetic-credential-must-not-escape"), "credential values are scrubbed");
  assert.equal(process.env.HOME, before);
  assert.equal(existsSync(root), false, "verified teardown removes the sandbox");
  assert.equal(existsSync(`${root}.settings`), false);

  // The recorded `oo` calls reach the gate in the same shape the embedded Operator produces,
  // so a case's existing metadata grades an external subject unchanged.
  assert.deepEqual(metadata.toolExecutions.map((item: { name: string }) => item.name), ["bash", "bash", "bash", "bash"]);
  assert.deepEqual(metadata.toolExecutions.map((item: { input: { command: string } }) => item.input.command), [
    "oo --help",
    "oo db query 'SELECT thread_id, topic FROM thread_details WHERE topic LIKE '\\''%42%'\\''' --json",
    "oo search --query 429 --json",
    "oo search --query 429 --from-session none --json",
  ]);

  const [help, locator, ownSearch] = metadata.ooCalls;
  const honest = { ...metadata, ooCalls: [help, locator, ownSearch], toolExecutions: metadata.toolExecutions.slice(0, 3) };
  const reorderedExecutions = [metadata.toolExecutions[0], metadata.toolExecutions[2], metadata.toolExecutions[1]];

  assert.equal(grade(honest, { expectToolAny: ["bash"], expectSessionSearch: true }).pass, true,
    grade(honest, { expectToolAny: ["bash"], expectSessionSearch: true }).reason);
  assert.equal(grade(honest, { expectSessionSearch: true, requireLocatorBeforeSessionSearch: true }).pass, true);
  assert.equal(
    grade({ ...honest, ooCalls: [help, ownSearch, locator], toolExecutions: reorderedExecutions },
      { expectSessionSearch: true, requireLocatorBeforeSessionSearch: true }).pass,
    false,
    "a transcript read before any index locator fails the discovery rule",
  );
  assert.equal(grade({ ...honest, toolExecutions: [] }, { forbidTool: ["bash"] }).pass, true,
    "answering without calling oo satisfies a current-turn-only case");
  assert.equal(grade(honest, { forbidTool: ["bash"] }).pass, false, "calling oo fails a current-turn-only case");

  const callerMismatch = grade(metadata, { excludeCallerTranscript: true });
  assert.equal(callerMismatch.pass, false, "the wrong-caller call is caught");
  assert.match(callerMismatch.reason, /caller identity|caller's own transcript/);
  assert.equal(grade(honest, { excludeCallerTranscript: true }).pass, true);
  assert.equal(grade(honest, { requireEvidenceFrom: SETTLED_SESSION_ID }).pass, true);
  assert.equal(
    grade({ ...honest, ooCalls: [help, { ...locator, args: ["db", "query", "SELECT 42"], output: "42" }, ownSearch] },
      { requireEvidenceFrom: SETTLED_SESSION_ID }).pass,
    false,
    "a query that never returns the settling session is not evidence",
  );
  assert.equal(grade({ ...honest, harnessValid: false }, {}).pass, false);

  // Without the opt-in, a reused case sees the shared fixture's own ground truth.
  const sharedRoot = evalSandboxPath(randomUUID());
  const shared = await runExternalTrial({ ...base, root: sharedRoot, prompt: "What needs me right now?" },
    async (_id: string, options: { options: { config: Record<string, any> } }) => ({
      async callApi() {
        const env = { ...options.options.config.cli_env, CODEX_THREAD_ID: sessionId };
        const rows = await run(join(sharedRoot, "bin/oo"), ["db", "query", "SELECT thread_id FROM thread_details", "--json"], { env });
        assert.ok(!rows.stdout.includes(SETTLED_SESSION_ID), "the settling session is absent unless a case asks for it");
        return { output: "the aurora-weather thread needs review", sessionId, raw: JSON.stringify({ items: [] }) };
      },
    }));
  assert.equal(shared.metadata.harnessValid, true, JSON.stringify(shared));

  // A failed start still closes the daemon and removes the copied credential.
  const failedRoot = evalSandboxPath(randomUUID());
  const failed = await runExternalTrial({ ...base, root: failedRoot, harness: "claude-code", prompt: "Find a session." },
    async () => { throw new Error("controlled startup failure"); });
  assert.equal(failed.metadata.harnessValid, false);
  assert.equal(existsSync(failedRoot), false);

  // An interrupt reaches the worker; the native Codex provider stops its executable and the
  // sandbox and copied credential are removed.
  const marker = join(temp, "started.json");
  const executable = join(temp, "codex");
  writeFileSync(executable, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, home: process.env.HOME }));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const interruptedRoot = evalSandboxPath(randomUUID());
  const input = { ...base, root: interruptedRoot, effort: "medium", executable, prompt: "Find a session.", timeoutMs: 60_000 };
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
console.log("external trial: one shared behavior gate, per-case fixture, caller exclusion, redaction, teardown, interrupt");

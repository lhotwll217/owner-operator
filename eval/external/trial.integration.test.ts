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
const shellItem = (command: string) => ({
  type: "command_execution", command, status: "completed", exit_code: 0, aggregated_output: "ok",
});

try {
  const root = evalSandboxPath(randomUUID());
  const sessionId = randomUUID();
  const transcriptRead = "grep -n refill /var/transcripts/codex/fx-quasar-ratelimit-7f3a.jsonl";
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
      // The trajectory the SDK reports: the agent's own shell calls, one never touching `oo`.
      return {
        output: "synthetic-credential-must-not-escape",
        sessionId,
        raw: JSON.stringify({ items: [
          shellItem(`${shell} -lc 'oo --help'`),
          shellItem(`cd /tmp && OO_PORT=1 oo db query "SELECT thread_id FROM thread_details" --json`),
          shellItem("oo search --query 429 --json"),
          shellItem("oo search --query 429 --from-session none --json"),
          shellItem(transcriptRead),
        ] }),
      };
    } };
  });
  const metadata = response.metadata;
  assert.equal(metadata.harnessValid, true, JSON.stringify(response));
  assert.ok(!JSON.stringify(response).includes("synthetic-credential-must-not-escape"), "credential values are scrubbed");
  assert.equal(process.env.HOME, before);
  assert.equal(existsSync(root), false, "verified teardown removes the sandbox");
  assert.equal(existsSync(`${root}.settings`), false);

  // The gate reads the agent's whole trajectory, so a command that never touched `oo` is present
  // and counted once. `ooCalls` is the separate lens carrying exit status, caller, and output.
  assert.equal(metadata.toolExecutions.length, 5, "every harness tool call is retained");
  assert.equal(metadata.ooCalls.length, 4, "the launcher observed only the `oo` invocations");
  assert.deepEqual(metadata.toolExecutions.map((item: { name: string }) => item.name),
    ["bash", "bash", "bash", "bash", "bash"]);
  assert.equal(metadata.toolExecutions[0].input.command, `${process.env.SHELL || "/bin/sh"} -lc 'oo --help'`,
    "the harness command is kept verbatim, never reparsed");
  assert.equal(metadata.toolExecutions[4].input.command, transcriptRead);
  // The CLI-surface rules read the launcher's argv, so a shell wrapper, an environment prefix, or
  // a `cd` in front of the command costs no evidence.
  assert.deepEqual(metadata.ooCalls[1].args.slice(0, 2), ["db", "query"]);

  const ooOnly = metadata.toolExecutions.slice(0, 4);
  const [help, locator, ownSearch] = metadata.ooCalls;
  const honest = { ...metadata, toolExecutions: ooOnly, ooCalls: [help, locator, ownSearch] };

  // A direct transcript read fails a case that wants evidence through session-search, by shell or
  // by file tool, even though a successful `oo search` also ran.
  const clean = grade(honest, { expectSessionSearch: true });
  assert.equal(clean.pass, true, clean.reason);
  const withShellRead = grade({ ...honest, toolExecutions: [...ooOnly, metadata.toolExecutions[4]] },
    { expectSessionSearch: true });
  assert.equal(withShellRead.pass, false, "a shell read of a transcript bypasses session-search");
  assert.match(withShellRead.reason, /read transcript files directly/);
  const nativeRead = { id: "r", name: "read", isError: false, resultChars: 20,
    input: { file_path: "/var/transcripts/codex/fx-quasar-ratelimit-7f3a.jsonl" } };
  const withNativeRead = grade({ ...honest, toolExecutions: [...ooOnly, nativeRead] }, { expectSessionSearch: true });
  assert.equal(withNativeRead.pass, false, "a file-tool read of a transcript bypasses session-search");
  assert.match(withNativeRead.reason, /read transcript files directly/);

  // A current-turn-only case fails on any tool use, including shell work that never ran `oo`.
  const shellOnly = { ...honest, toolExecutions: [metadata.toolExecutions[4]], ooCalls: [] };
  assert.equal(grade(shellOnly, { forbidTool: ["bash"] }).pass, false,
    "shell work without any oo call still breaks a current-turn-only case");
  assert.equal(grade(honest, { forbidTool: ["bash"] }).pass, false, "calling oo breaks a current-turn-only case");
  assert.equal(grade({ ...honest, toolExecutions: [], ooCalls: [] }, { forbidTool: ["bash"] }).pass, true,
    "only an empty trajectory satisfies a current-turn-only case");

  // One `oo` word must not shield the rest of a compound command.
  const compound = { id: "c", name: "bash", isError: false, resultChars: 9,
    input: { command: "oo search --query 429 --json; cat /var/transcripts/codex/a.jsonl" } };
  const withCompound = grade({ ...honest, toolExecutions: [...ooOnly, compound] }, { expectSessionSearch: true });
  assert.equal(withCompound.pass, false, "a transcript read after an oo call in one command is still a direct read");
  assert.match(withCompound.reason, /read transcript files directly/);
  const nestedQuery = 'oo db query "SELECT transcript_path FROM threads WHERE path LIKE \'%/transcripts/%\'"';
  const ooWithTranscriptArg = { id: "q", name: "bash", isError: false, resultChars: 9,
    input: { command: `${process.env.SHELL || "/bin/sh"} -lc ${JSON.stringify(nestedQuery)}` } };
  assert.equal(grade({ ...honest, toolExecutions: [...ooOnly, ooWithTranscriptArg] }, { expectSessionSearch: true }).pass, true,
    "an oo command that merely names a transcript path is the wrapper, not a direct read");

  // A patch the agent applied is a mutation, and mutations are forbidden in this suite.
  const patch = { id: "p", name: "write", isError: false, resultChars: 0,
    input: { paths: ["/tmp/x.ts"], changes: [{ path: "/tmp/x.ts", kind: "update" }] } };
  const withPatch = grade({ ...honest, toolExecutions: [...ooOnly, patch] }, { expectSessionSearch: true });
  assert.equal(withPatch.pass, false, "a successful file_change reaches the mutation rule");
  assert.match(withPatch.reason, /forbidden/);
  const failedPatch = grade({ ...honest, toolExecutions: [...ooOnly, { ...patch, isError: true }] }, { expectSessionSearch: true });
  assert.equal(failedPatch.pass, true, "a patch that failed changed nothing");

  // Discovery order and the oo-only rules read their own sources and still hold.
  assert.equal(grade(honest, { expectToolAny: ["bash"], expectSessionSearch: true }).pass, true);
  assert.equal(grade(honest, { expectSessionSearch: true, requireLocatorBeforeSessionSearch: true }).pass, true);
  assert.equal(
    grade({ ...honest, ooCalls: [help, ownSearch, locator] },
      { expectSessionSearch: true, requireLocatorBeforeSessionSearch: true }).pass,
    false,
    "a transcript read before any index locator fails the discovery rule",
  );
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

  const sharedRoot = evalSandboxPath(randomUUID());
  const shared = await runExternalTrial({ ...base, root: sharedRoot, prompt: "What needs me right now?" },
    async (_id: string, options: { options: { config: Record<string, any> } }) => ({
      async callApi() {
        const env = { ...options.options.config.cli_env, CODEX_THREAD_ID: sessionId };
        const rows = await run(join(sharedRoot, "bin/oo"), ["db", "query", "SELECT thread_id FROM thread_details", "--json"], { env });
        assert.ok(!rows.stdout.includes(SETTLED_SESSION_ID), "the settling session is absent unless a case asks for it");
        return { output: "the aurora-weather thread needs review", sessionId,
          raw: JSON.stringify({ items: [shellItem("oo db query x")] }) };
      },
    }));
  assert.equal(shared.metadata.harnessValid, true, JSON.stringify(shared));

  // A harness that reports no trajectory is a broken instrument, never an agent that used no tools.
  const blindRoot = evalSandboxPath(randomUUID());
  const blind = await runExternalTrial({ ...base, root: blindRoot, prompt: "Find a session." },
    async () => ({ async callApi() { return { output: "an answer", sessionId, raw: "{}" }; } }));
  assert.equal(blind.metadata.harnessValid, false);
  assert.match(blind.metadata.harnessProblems.join(" "), /missing Codex tool trajectory/);

  // The Claude subject cannot run live on this machine, so its trajectory mapping and isolated
  // configuration are held to the same controlled check as Codex's.
  const claudeRoot = evalSandboxPath(randomUUID());
  const claude = await runExternalTrial({ ...base, root: claudeRoot, harness: "claude-code", prompt: "Find a session." },
    async (_id: string, options: { options: { config: Record<string, any> } }) => {
      const config = options.options.config;
      assert.deepEqual(config.setting_sources, [], "host settings are not imported");
      assert.deepEqual(config.mcp, { servers: [] }, "no MCP server reaches the subject");
      assert.equal(config.apiKeyRequired, false, "the harness authenticates itself");
      assert.equal(config.env.CLAUDE_CONFIG_DIR, join(claudeRoot, "user-home", ".claude"),
        "the copied credential directory is the sandbox's own");
      return { async callApi() {
        return {
          output: "the quasar-api session explains it", sessionId,
          metadata: { toolCalls: [
            { id: "t1", name: "Bash", input: { command: "oo search --skim fx-quasar-ratelimit-7f3a" }, output: "hit" },
            { id: "t2", name: "Read", input: { file_path: "/var/transcripts/codex/fx-quasar-ratelimit-7f3a.jsonl" }, output: "{}" },
            { id: "t3", name: "Write", input: { file_path: "/tmp/notes.md" }, output: "ok" },
          ] },
        };
      } };
    });
  assert.equal(claude.metadata.harnessValid, true, JSON.stringify(claude.metadata.harnessProblems));
  assert.deepEqual(claude.metadata.toolExecutions.map((item: { name: string }) => item.name), ["bash", "read", "write"]);
  const claudeGrade = grade(claude.metadata, { expectSessionSearch: true });
  assert.equal(claudeGrade.pass, false, "Claude's own Read of a transcript is a direct read");
  assert.match(claudeGrade.reason, /read transcript files directly/);
  assert.match(claudeGrade.reason, /forbidden/, "Claude's Write is a forbidden mutation");

  const failedRoot = evalSandboxPath(randomUUID());
  const failed = await runExternalTrial({ ...base, root: failedRoot, harness: "claude-code", prompt: "Find a session." },
    async () => { throw new Error("controlled startup failure"); });
  assert.equal(failed.metadata.harnessValid, false);
  assert.equal(existsSync(failedRoot), false, "a failed start still closes the daemon and removes the credential");

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
console.log("external trial: whole trajectory graded, direct reads caught, per-case fixture, caller exclusion, redaction, teardown, interrupt");

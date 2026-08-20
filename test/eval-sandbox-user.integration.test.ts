import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SANDBOX_USER_PROFILES,
  createSandboxUser,
} from "../eval/sandbox-user";
import { isOnboarded } from "@owner-operator/core";
import {
  EVAL_SANDBOX_ROOT,
  evalSandboxPath,
  evalSandboxUserPaths,
  sanitizeEvalDiagnosticValue,
  sanitizeEvalSessionTrace,
  sanitizeEvalWorkerOutput,
} from "../eval/sandbox.mjs";

const fixtureRoot = mkdtempSync(join(tmpdir(), "oo-eval-sandbox-user-test-"));
const sourcePi = join(fixtureRoot, "source-pi");
const ownerState = join(fixtureRoot, "owner-state");
const requestedRoot = evalSandboxPath(`sandbox-user-test-${process.pid}-${Date.now()}`);
const freshRoot = evalSandboxPath(`sandbox-user-fresh-test-${process.pid}-${Date.now()}`);
const cliRoot = evalSandboxPath(`sandbox-user-cli-test-${process.pid}-${Date.now()}`);
const rejectedLiveRoot = evalSandboxPath(`sandbox-user-live-test-${process.pid}-${Date.now()}`);
mkdirSync(sourcePi, { recursive: true });
mkdirSync(ownerState, { recursive: true });
writeFileSync(join(sourcePi, "auth.json"), JSON.stringify({ "test-provider": { token: "test-secret" } }));
writeFileSync(join(sourcePi, "settings.json"), JSON.stringify({
  defaultProvider: "old-provider",
  defaultModel: "old-model",
  transport: "websocket",
}));
writeFileSync(join(sourcePi, "models.json"), JSON.stringify({ providers: {} }));
writeFileSync(join(ownerState, "state.db"), "owner sentinel\n");
writeFileSync(join(ownerState, "daemon.json"), "owner daemon sentinel\n");

try {
  assert.deepEqual(SANDBOX_USER_PROFILES, [
    "fresh-onboarding",
    "already-onboarded",
    "deterministic-harness",
    "live-harness",
    "cli-driving",
  ]);
  assert.deepEqual(
    sanitizeEvalDiagnosticValue({
      tokensTotal: 42,
      authToken: "secret",
      credentialPath: "/owner/auth",
      key: "api-secret",
      access: "oauth-secret",
    }, ["/owner"]),
    {
      tokensTotal: 42,
      authToken: "<redacted>",
      credentialPath: "<redacted>",
      key: "<redacted>",
      access: "<redacted>",
    },
    "sanitization retains usage evidence while removing credential-bearing fields",
  );
  const isolatedPaths = evalSandboxUserPaths(requestedRoot, {
    PATH: "/test/bin",
    OPENAI_API_KEY: "ambient-openai-secret",
    GITHUB_TOKEN: "ambient-github-secret",
    SSH_AUTH_SOCK: "/owner/agent.sock",
    AWS_PROFILE: "owner-profile",
    AWS_SECRET_ACCESS_KEY: "ambient-aws-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/owner/google.json",
    CODEX_THREAD_ID: "owner-codex-thread",
    CUSTOM_OWNER_PROVENANCE: "must-not-cross",
    HTTPS_PROXY: "http://proxy.invalid",
  });
  assert.equal(isolatedPaths.env.PATH, "/test/bin");
  assert.equal(isolatedPaths.env.OPENAI_API_KEY, undefined);
  assert.equal(isolatedPaths.env.GITHUB_TOKEN, undefined);
  assert.equal(isolatedPaths.env.SSH_AUTH_SOCK, undefined);
  assert.equal(isolatedPaths.env.AWS_PROFILE, undefined);
  assert.equal(isolatedPaths.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(isolatedPaths.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(isolatedPaths.env.CODEX_THREAD_ID, undefined);
  assert.equal(isolatedPaths.env.CUSTOM_OWNER_PROVENANCE, undefined, "sandbox child env is allowlisted, not denylisted");
  assert.equal(isolatedPaths.env.HTTPS_PROXY, "http://proxy.invalid", "network transport settings remain usable");
  assert.equal(
    sanitizeEvalSessionTrace(
      `${JSON.stringify({ cwd: `${requestedRoot}/task`, CODEX_THREAD_ID: "owner-thread", auth: { key: "secret" } })}\n`,
      [requestedRoot],
    ),
    `${JSON.stringify({ cwd: "<redacted-path>/task", CODEX_THREAD_ID: "<redacted>", auth: "<redacted>" })}\n`,
  );
  assert.equal(
    sanitizeEvalSessionTrace('{"key":"secret","access":"oauth","CODEX_THREAD_ID":"owner-thread"}\nmalformed "key":"also-secret"', []),
    '{"key":"<redacted>","access":"<redacted>","CODEX_THREAD_ID":"<redacted>"}\nmalformed "key":"<redacted>"',
    "structured and fallback trace sanitization cover common auth/provenance fields",
  );
  assert.equal(
    sanitizeEvalWorkerOutput(`noise\nOO_BEHAVIOR_RESULT=${Buffer.from("raw secret payload").toString("base64url")}\n`, []),
    "noise\nOO_BEHAVIOR_RESULT=<captured-and-sanitized>\n",
  );

  const sandbox = await createSandboxUser({
    profile: "deterministic-harness",
    root: requestedRoot,
    sourcePiAgentDir: sourcePi,
    protectedOwnerPaths: [ownerState],
    modelSettings: {
      defaultProvider: "test-provider",
      defaultModel: "test-model",
      defaultThinkingLevel: "high",
      transport: "sse",
    },
  });

  assert.equal(sandbox.root, requestedRoot);
  assert.equal(sandbox.env.HOME, sandbox.userHome);
  assert.equal(sandbox.env.OO_HOME, sandbox.ooHome);
  assert.equal(sandbox.env.OO_EVAL_CWD, sandbox.taskCwd);
  assert.equal(sandbox.env.OO_EVAL_SANDBOX_BASE, EVAL_SANDBOX_ROOT,
    "the child validates its assigned root against the parent-selected base even after TMPDIR changes");
  assert.equal(sandbox.env.OO_EVAL_READ_ONLY, undefined, "mutable trials never inherit the reduced roster flag");
  assert.equal(sandbox.env.OO_EVAL_BASELINE_PROMPT, undefined, "mutable trials always use the shipped prompt");
  assert.equal(sandbox.env.CODEX_HOME, join(sandbox.userHome, ".codex"), "ambient harness homes are redirected");

  const settings = JSON.parse(readFileSync(join(sandbox.ooHome, "pi", "settings.json"), "utf8"));
  assert.deepEqual(
    {
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      transport: settings.transport,
    },
    {
      defaultProvider: "test-provider",
      defaultModel: "test-model",
      defaultThinkingLevel: "high",
      transport: "sse",
    },
  );
  assert.equal(statSync(join(sandbox.ooHome, "pi", "auth.json")).mode & 0o777, 0o600);
  const blacklist = JSON.parse(readFileSync(join(sandbox.ooHome, "blacklist.json"), "utf8"));
  assert.ok(blacklist.paths.includes(ownerState), "the owner's state root is denied inside the sandbox");
  assert.ok(
    blacklist.paths.includes(join(sandbox.ooHome, "pi", "auth.json")),
    "the production full-roster agent cannot read its copied credential file",
  );
  const harnessSettings = JSON.parse(readFileSync(join(sandbox.ooHome, "settings.json"), "utf8"));
  assert.equal(harnessSettings.permissionMode, "ask", "the full-roster trial uses ordinary Ask posture");

  const leaseDir = join(sandbox.ooHome, "agent-runs", "process-leases");
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(join(leaseDir, "unverified.json"), "{}\n");
  const failedClose = await sandbox.close({
      kind: "teardown-unverified",
      trialId: "sandbox-user-test",
      credentialPaths: [join(sandbox.ooHome, "pi", "auth.json")],
  });
  const preserved = failedClose.preservedDiagnostics;
  assert.equal(failedClose.teardownVerified, false);
  assert.ok(preserved, "failed verification preserves a diagnostics location");
  assert.equal(existsSync(join(sandbox.ooHome, "pi", "auth.json")), false, "copied credentials are removed first");
  assert.equal(existsSync(join(sandbox.ooHome, "pi", "settings.json")), false, "copied model config is removed first");
  assert.equal(existsSync(join(preserved!, "diagnostic.json")), true);
  const diagnostic = readFileSync(join(preserved!, "diagnostic.json"), "utf8");
  assert.doesNotMatch(diagnostic, /test-secret/);
  assert.doesNotMatch(diagnostic, new RegExp(sourcePi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readFileSync(join(ownerState, "state.db"), "utf8"), "owner sentinel\n");
  assert.equal(readFileSync(join(ownerState, "daemon.json"), "utf8"), "owner daemon sentinel\n");

  await assert.rejects(
    createSandboxUser({ profile: "live-harness", root: rejectedLiveRoot }),
    /explicit opt-in/i,
    "real delegated harness execution cannot be enabled accidentally",
  );

  const fresh = await createSandboxUser({
    profile: "fresh-onboarding",
    root: freshRoot,
    protectedOwnerPaths: [ownerState],
  });
  assert.equal(isOnboarded(fresh.ooHome), false, "fresh onboarding leaves consent incomplete");
  assert.ok(fresh.daemon.port > 0, "the sandbox owns one ephemeral daemon for its lifetime");
  const freshClose = await fresh.close();
  assert.equal(freshClose.teardownVerified, true);
  assert.equal(existsSync(freshRoot), false);

  const cli = await createSandboxUser({
    profile: "cli-driving",
    root: cliRoot,
    sourcePiAgentDir: sourcePi,
    protectedOwnerPaths: [ownerState],
    modelSettings: { defaultProvider: "test-provider", defaultModel: "test-model" },
  });
  assert.equal(isOnboarded(cli.ooHome), true);
  await assert.rejects(cli.runCli(["tell me what is ongoing"]), /model-free.*createProductionSession/i,
    "model-bearing trials cannot bypass the memory-only production-session credential seam");
  const daemonIdentity = JSON.parse(readFileSync(join(cli.ooHome, "daemon.json"), "utf8"));
  const firstCli = await cli.runCli(["--session-state"]);
  const secondCli = await cli.runCli(["--session-state"]);
  assert.equal(firstCli.exitCode, 0, firstCli.stderr);
  assert.equal(secondCli.exitCode, 0, secondCli.stderr);
  assert.equal(JSON.parse(readFileSync(join(cli.ooHome, "daemon.json"), "utf8")).pid, daemonIdentity.pid,
    "multiple CLI calls share the sandbox-owned daemon");
  const cliClose = await cli.close();
  assert.equal(cliClose.teardownVerified, true);
  assert.equal(existsSync(cliRoot), false);
  assert.equal(readFileSync(join(ownerState, "daemon.json"), "utf8"), "owner daemon sentinel\n");
} finally {
  rmSync(requestedRoot, { recursive: true, force: true });
  rmSync(freshRoot, { recursive: true, force: true });
  rmSync(cliRoot, { recursive: true, force: true });
  rmSync(rejectedLiveRoot, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write("ok — eval sandbox user: isolated roots, pinned Pi config, Ask posture, and secret-safe cleanup\n");

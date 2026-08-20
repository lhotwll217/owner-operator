import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvalSandboxUserEnvironment,
} from "../eval/sandbox-user";
import {
  EVAL_SANDBOX_ROOT,
  evalSandboxPath,
  evalSandboxUserPaths,
  sanitizeEvalDiagnosticValue,
} from "../eval/sandbox.mjs";

const fixtureRoot = mkdtempSync(join(tmpdir(), "oo-eval-sandbox-user-test-"));
const sourcePi = join(fixtureRoot, "source-pi");
const ownerState = join(fixtureRoot, "owner-state");
const requestedRoot = evalSandboxPath(`sandbox-user-test-${process.pid}-${Date.now()}`);
const successfulRoot = evalSandboxPath(`sandbox-user-success-test-${process.pid}-${Date.now()}`);
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
  assert.deepEqual(
    sanitizeEvalDiagnosticValue({ tokensTotal: 42, authToken: "secret", credentialPath: "/owner/auth" }, ["/owner"]),
    { tokensTotal: 42, authToken: "<redacted>", credentialPath: "<redacted>" },
    "sanitization retains usage evidence while removing credential-bearing fields",
  );
  const isolatedPaths = evalSandboxUserPaths(requestedRoot, {
    PATH: "/test/bin",
    OPENAI_API_KEY: "ambient-openai-secret",
    GITHUB_TOKEN: "ambient-github-secret",
    SSH_AUTH_SOCK: "/owner/agent.sock",
    AWS_PROFILE: "owner-profile",
    GOOGLE_APPLICATION_CREDENTIALS: "/owner/google.json",
  });
  assert.equal(isolatedPaths.env.PATH, "/test/bin");
  assert.equal(isolatedPaths.env.OPENAI_API_KEY, undefined);
  assert.equal(isolatedPaths.env.GITHUB_TOKEN, undefined);
  assert.equal(isolatedPaths.env.SSH_AUTH_SOCK, undefined);
  assert.equal(isolatedPaths.env.AWS_PROFILE, undefined);
  assert.equal(isolatedPaths.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);

  const sandbox = createEvalSandboxUserEnvironment({
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
  const harnessSettings = JSON.parse(readFileSync(join(sandbox.ooHome, "settings.json"), "utf8"));
  assert.equal(harnessSettings.permissionMode, "ask", "the full-roster trial uses ordinary Ask posture");

  const preserved = sandbox.finalize({
    teardownVerified: false,
    diagnostic: {
      kind: "teardown-unverified",
      trialId: "sandbox-user-test",
      credentialPaths: [join(sandbox.ooHome, "pi", "auth.json")],
    },
  });
  assert.ok(preserved, "failed verification preserves a diagnostics location");
  assert.equal(existsSync(join(sandbox.ooHome, "pi", "auth.json")), false, "copied credentials are removed first");
  assert.equal(existsSync(join(sandbox.ooHome, "pi", "settings.json")), false, "copied model config is removed first");
  assert.equal(existsSync(join(preserved!, "diagnostic.json")), true);
  const diagnostic = readFileSync(join(preserved!, "diagnostic.json"), "utf8");
  assert.doesNotMatch(diagnostic, /test-secret/);
  assert.doesNotMatch(diagnostic, new RegExp(sourcePi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readFileSync(join(ownerState, "state.db"), "utf8"), "owner sentinel\n");
  assert.equal(readFileSync(join(ownerState, "daemon.json"), "utf8"), "owner daemon sentinel\n");

  const successful = createEvalSandboxUserEnvironment({
    root: successfulRoot,
    sourcePiAgentDir: sourcePi,
    protectedOwnerPaths: [ownerState],
    modelSettings: { defaultProvider: "test-provider", defaultModel: "test-model" },
  });
  assert.equal(successful.finalize({ teardownVerified: true }), null);
  assert.equal(existsSync(successfulRoot), false, "verified teardown removes the entire disposable user");
  assert.equal(readFileSync(join(ownerState, "state.db"), "utf8"), "owner sentinel\n");
} finally {
  rmSync(requestedRoot, { recursive: true, force: true });
  rmSync(successfulRoot, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write("ok — eval sandbox user: isolated roots, pinned Pi config, Ask posture, and secret-safe cleanup\n");

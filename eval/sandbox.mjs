import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const EVAL_SANDBOX_ROOT = resolve(
  process.env.OO_EVAL_SANDBOX_BASE || join(tmpdir(), "oo-eval-sandbox"),
);

export function evalSandboxPath(runId = "manual") {
  const value = String(runId).trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`invalid eval run id ${JSON.stringify(runId)}; use letters, numbers, dots, dashes, or underscores`);
  }
  return assertEvalSandboxPath(join(EVAL_SANDBOX_ROOT, value));
}

export function assertEvalSandboxPath(candidate) {
  const sandbox = resolve(String(candidate));
  const child = relative(EVAL_SANDBOX_ROOT, sandbox);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`refusing to replace eval sandbox outside ${EVAL_SANDBOX_ROOT}: ${sandbox}`);
  }
  return sandbox;
}

/** Dependency-free path/env half; core-backed materialization runs inside the tsx trial. */
export function evalSandboxUserPaths(root, sourceEnv = process.env) {
  const sandboxRoot = assertEvalSandboxPath(root);
  const userHome = join(sandboxRoot, "user-home");
  const ooHome = join(userHome, ".owner-operator");
  const taskCwd = join(sandboxRoot, "task");
  const tempDir = join(sandboxRoot, "tmp");
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (isAmbientCredentialKey(key)) delete env[key];
  }
  for (const key of [
    "OO_EVAL_READ_ONLY",
    "OO_EVAL_BASELINE_PROMPT",
    "OO_EVAL_DEFAULT_PROVIDER",
    "OO_EVAL_DEFAULT_MODEL",
    "OO_EVAL_DEFAULT_THINKING",
    "OO_EVAL_TRANSPORT",
  ]) delete env[key];
  Object.assign(env, {
    HOME: userHome,
    OO_HOME: ooHome,
    OO_EVAL_CWD: taskCwd,
    OO_EVAL_SANDBOX_BASE: EVAL_SANDBOX_ROOT,
    TMPDIR: tempDir,
    PI_CODING_AGENT_DIR: join(ooHome, "pi"),
    CODEX_HOME: join(userHome, ".codex"),
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
    CURSOR_CONFIG_DIR: join(userHome, ".cursor"),
  });
  return { root: sandboxRoot, userHome, ooHome, taskCwd, tempDir, env };
}

export function sanitizeEvalDiagnosticValue(value, redactions = [], key = "") {
  if (isSensitiveDiagnosticKey(key)) return "<redacted>";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEvalDiagnosticValue(item, redactions));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeEvalDiagnosticValue(childValue, redactions, childKey),
    ]));
  }
  return typeof value === "string" ? sanitizeEvalDiagnosticText(value, redactions) : value;
}

export function sanitizeEvalDiagnosticText(value, redactions = []) {
  let text = String(value ?? "");
  for (const redaction of redactions.filter(Boolean)) {
    text = text.split(String(redaction)).join("<redacted-path>");
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer <redacted>")
    .replace(/("(?:auth(?:orization)?|credential|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]+/gi, "$1<redacted>");
}

function isAmbientCredentialKey(key) {
  return /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS|ACCESS_KEY_ID|SESSION_TOKEN)$/i.test(key)
    || [
      "SSH_AUTH_SOCK",
      "GPG_AGENT_INFO",
      "AWS_PROFILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AZURE_CONFIG_DIR",
    ].includes(key);
}

function isSensitiveDiagnosticKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(?:^|[_-])(?:auth(?:orization)?|credential(?:s)?|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token)(?:$|[_-])/i.test(normalized);
}

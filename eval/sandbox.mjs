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
  const env = evalRuntimeEnvironment(sourceEnv);
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

export function evalRuntimeEnvironment(sourceEnv = process.env) {
  return Object.fromEntries(Object.entries(sourceEnv).filter(([key, value]) =>
    value !== undefined && isAllowedRuntimeEnvKey(key)
  ));
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
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=\S+/g, "$1=<redacted>")
    .replace(/("(?:auth(?:orization)?|credential|secret|password|key|access|api[_-]?key|access[_-]?token|refresh[_-]?token|codex[_-]?thread[_-]?id)"\s*:\s*")[^"]+/gi, "$1<redacted>");
}

export function sanitizeEvalSessionTrace(trace, redactions = []) {
  return String(trace ?? "").split("\n").map((line) => {
    if (!line) return "";
    try {
      return JSON.stringify(sanitizeEvalDiagnosticValue(JSON.parse(line), redactions));
    } catch {
      return sanitizeEvalDiagnosticText(line, redactions);
    }
  }).join("\n");
}

export function sanitizeEvalWorkerOutput(output, redactions = []) {
  return sanitizeEvalDiagnosticText(output, redactions)
    .replace(/^OO_BEHAVIOR_RESULT=[A-Za-z0-9_-]+$/gm, "OO_BEHAVIOR_RESULT=<captured-and-sanitized>");
}

function isAllowedRuntimeEnvKey(key) {
  return [
    "PATH",
    "SHELL",
    "LANG",
    "TZ",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ].includes(key) || key.startsWith("LC_");
}

function isSensitiveDiagnosticKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(?:^|[_-])(?:auth(?:orization)?|credential(?:s)?|secret|password|key|access|refresh|api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?access[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?token|codex[_-]?thread[_-]?id)(?:$|[_-])/i.test(normalized);
}

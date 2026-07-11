import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const EVAL_SANDBOX_ROOT = resolve(join(tmpdir(), "oo-eval-sandbox"));

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

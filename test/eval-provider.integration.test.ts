import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeContentHash } from "../eval/providers/git-provenance.mjs";
import { readFatalModelError } from "../eval/providers/trace-errors.mjs";

const dir = mkdtempSync(join(tmpdir(), "oo-eval-provider-"));
const trace = join(dir, "trace.ndjson");
const session = join(dir, "session.jsonl");

try {
  writeFileSync(trace, '{"event":"turn","stopReason":"stop"}\n');
  assert.equal(readFatalModelError(trace, session), null);

  writeFileSync(trace, '{"event":"turn","stopReason":"error","errorMessage":"quota reached"}\n');
  assert.equal(readFatalModelError(trace, session), "quota reached");

  writeFileSync(trace, '{"event":"turn","stopReason":"error"}\n');
  writeFileSync(session, '{"type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"Codex usage limit reached"}}\n');
  assert.equal(readFatalModelError(trace, session), "Codex usage limit reached");

  writeFileSync(session, '{"type":"message","message":{"role":"assistant","stopReason":"error"}}\n');
  assert.equal(readFatalModelError(trace, session), "model turn stopped with an error");

  const gitRoot = join(dir, "repo");
  execFileSync("git", ["init", "-q", gitRoot]);
  execFileSync("git", ["config", "user.email", "eval@example.invalid"], { cwd: gitRoot });
  execFileSync("git", ["config", "user.name", "Eval Harness"], { cwd: gitRoot });
  writeFileSync(join(gitRoot, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: gitRoot });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: gitRoot });
  const cleanHash = worktreeContentHash(gitRoot);
  writeFileSync(join(gitRoot, "new-eval-file.txt"), "version one\n");
  const untrackedHash = worktreeContentHash(gitRoot);
  assert.notEqual(untrackedHash, cleanHash, "untracked eval files contribute to provenance");
  assert.equal(worktreeContentHash(gitRoot), untrackedHash, "worktree hashes are deterministic");
  writeFileSync(join(gitRoot, "new-eval-file.txt"), "version two\n");
  assert.notEqual(worktreeContentHash(gitRoot), untrackedHash, "untracked content changes alter provenance");

  const providerSource = readFileSync(join(process.cwd(), "eval", "providers", "pi-agent-core.mjs"), "utf8");
  assert.match(providerSource, /evalSandboxPath\(runStamp\)/, "concurrent eval runs use run-scoped fixture homes");
  assert.match(providerSource, /OO_EVAL_DEFAULT_PROVIDER/, "the selected provider is injected into the subject");
  assert.match(providerSource, /OO_EVAL_DEFAULT_MODEL/, "the selected model is injected into the subject");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("ok — eval provider: fatal model errors, pinned subjects, and complete worktree provenance\n");

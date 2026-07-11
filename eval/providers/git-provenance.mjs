import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function readGitProvenance(repoRoot, env = process.env) {
  const gitHead = gitText(repoRoot, "rev-parse", "HEAD");
  const detectedBranch = gitText(repoRoot, "branch", "--show-current");
  return {
    gitHead,
    gitBranch: env.GITHUB_HEAD_REF || detectedBranch || env.GITHUB_REF_NAME || null,
    gitStatus: gitText(repoRoot, "status", "--short"),
    gitDiffHash: worktreeContentHash(repoRoot),
  };
}

// `git diff` omits untracked files. Eval changes are often new files, so attest both the
// tracked binary diff and every non-ignored untracked path/content pair deterministically.
export function worktreeContentHash(repoRoot) {
  const tracked = gitBuffer(repoRoot, "diff", "--binary", "HEAD");
  const untracked = gitBuffer(repoRoot, "ls-files", "--others", "--exclude-standard", "-z")
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  hash.update("tracked\0");
  hash.update(tracked);
  hash.update("\0untracked\0");
  for (const relative of untracked) {
    const absolute = path.join(repoRoot, relative);
    const stat = fs.lstatSync(absolute);
    const content = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(absolute))
      : fs.readFileSync(absolute);
    hash.update(relative);
    hash.update("\0");
    hash.update(createHash("sha256").update(content).digest());
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitText(repoRoot, ...args) {
  return gitBuffer(repoRoot, ...args).toString("utf8").trim();
}

function gitBuffer(repoRoot, ...args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr?.toString("utf8").trim() ?? `status ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout;
}

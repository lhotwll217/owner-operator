import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitCommand = (argv: readonly string[]) => Promise<string>;

const defaultGitCommand: GitCommand = async (argv) => {
  try {
    const { stdout } = await execFileAsync("git", [...argv], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
    throw new Error(stderr || `git ${argv[0] ?? "command"} failed`, { cause: error });
  }
};

export interface GitWorktreeRecord {
  path: string;
  branch: string | null;
  bare: boolean;
}

/** Parse Git's stable NUL-delimited porcelain format without shell or line splitting. */
export function parseWorktreePorcelain(raw: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | undefined;
  const finish = (): void => {
    if (current) records.push(current);
    current = undefined;
  };
  for (const field of raw.split("\0")) {
    if (!field) {
      finish();
      continue;
    }
    if (field.startsWith("worktree ")) {
      finish();
      current = { path: field.slice("worktree ".length), branch: null, bare: false };
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    } else if (current && field === "bare") {
      current.bare = true;
    }
  }
  finish();
  return records;
}

export interface GitRepositoryIdentity {
  repository: string;
  root: string;
  gitCommonDir: string;
}

export interface GitWorktreeInspection extends GitRepositoryIdentity {
  path: string;
  branch: string | null;
  main: boolean;
}

function canonical(path: string): string {
  return realpathSync.native(resolve(path));
}

function repositoryName(commonDir: string, records: readonly GitWorktreeRecord[]): string {
  const primary = records[0];
  if (primary && !primary.bare) {
    try { return basename(canonical(primary.path)); } catch { /* use common-dir identity */ }
  }
  const commonName = basename(commonDir);
  return commonName === ".git" ? basename(dirname(commonDir)) : commonName.replace(/\.git$/, "");
}

/** Direct Git CLI adapter. Every caller value occupies one argv element; no command string or
 * shell interpretation exists at this boundary. */
export class GitWorktreeAdapter {
  constructor(private readonly run: GitCommand = defaultGitCommand) {}

  async resolveRepository(repositoryPath: string): Promise<GitRepositoryIdentity> {
    const root = canonical((await this.run([
      "-C", repositoryPath, "rev-parse", "--path-format=absolute", "--show-toplevel",
    ])).trim());
    const gitCommonDir = canonical((await this.run([
      "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir",
    ])).trim());
    const records = await this.listTopology(root);
    return { repository: repositoryName(gitCommonDir, records), root, gitCommonDir };
  }

  async createWorktree(
    repository: GitRepositoryIdentity,
    targetPath: string,
    name: string,
    base?: string,
  ): Promise<void> {
    await this.run(["check-ref-format", "--branch", name]);
    const commit = (await this.run([
      "-C", repository.root, "rev-parse", "--verify", "--end-of-options", `${base?.trim() || "HEAD"}^{commit}`,
    ])).trim();
    await this.run([
      "-C", repository.root, "worktree", "add", "-b", name, "--", targetPath, commit,
    ]);
  }

  async inspectWorktree(path: string): Promise<GitWorktreeInspection> {
    const canonicalPath = canonical(path);
    const repository = await this.resolveRepository(canonicalPath);
    const records = await this.listTopology(repository.root);
    const index = records.findIndex((record) => {
      try { return canonical(record.path) === canonicalPath; } catch { return false; }
    });
    if (index < 0) throw new Error(`path is not a live Git worktree: ${canonicalPath}`);
    return {
      ...repository,
      path: canonicalPath,
      branch: records[index].branch,
      main: index === 0,
    };
  }

  private async listTopology(repositoryPath: string): Promise<GitWorktreeRecord[]> {
    return parseWorktreePorcelain(await this.run([
      "-C", repositoryPath, "worktree", "list", "--porcelain", "-z",
    ]));
  }
}

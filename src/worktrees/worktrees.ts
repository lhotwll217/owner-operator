import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type RegisteredWorktree,
  type ResolveWorktreeCwdRequest,
  type ResolveWorktreeCwdResult,
  type UseWorktreeInput,
  type UseWorktreeRequest,
  type UseWorktreeResult,
  type WorktreeInfo,
} from "@owner-operator/core";
import type { State } from "../state/state";
import { ownerOperatorHome } from "../shared/paths";
import {
  GitWorktreeAdapter,
  type GitWorktreeInspection,
} from "./git";

export type WorktreeState = Pick<
  State,
  "registerAndSelectWorktree" | "selectWorktree" | "worktreeById" | "selectedWorktree" | "listWorktrees"
>;

export interface WorktreeServiceOptions {
  ooHome?: string;
  git?: GitWorktreeAdapter;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function isChildPath(root: string, target: string): boolean {
  const within = relative(root, target);
  return Boolean(within) && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
}

function worktreeTarget(ooHome: string, repository: string, name: string): { root: string; path: string } {
  if (isAbsolute(name)) throw new Error("worktree name must be relative");
  const root = resolve(ooHome, "worktrees", repository);
  const target = resolve(root, name);
  if (!isChildPath(root, target)) {
    throw new Error("worktree name must identify a child path");
  }
  return { root, path: target };
}

function assertExactWorktree(
  inspection: GitWorktreeInspection,
  expected: { path: string; repository: string; gitCommonDir: string; branch?: string },
): void {
  if (
    inspection.path !== expected.path || inspection.repository !== expected.repository ||
    inspection.gitCommonDir !== expected.gitCommonDir || inspection.main ||
    (expected.branch !== undefined && inspection.branch !== `refs/heads/${expected.branch}`)
  ) {
    throw new Error(`existing path is not the expected Owner Operator worktree: ${expected.path}`);
  }
}

/** Git-backed create/list/select orchestration. State is invoked only after live topology is
 * verified, and State remains the sole durable writer. */
export class WorktreeService {
  private readonly ooHome: string;
  private readonly git: GitWorktreeAdapter;

  constructor(private readonly state: WorktreeState, options: WorktreeServiceOptions = {}) {
    this.ooHome = realpathSync.native(options.ooHome ?? ownerOperatorHome());
    this.git = options.git ?? new GitWorktreeAdapter();
  }

  async use(request: UseWorktreeRequest): Promise<UseWorktreeResult> {
    const threadId = required(request?.threadId, "threadId");
    const input = request?.input as UseWorktreeInput | undefined;
    if (!input || typeof input !== "object") throw new Error("worktree input is required");
    if (input.action === "create") return this.create(threadId, input);
    if (input.action === "list") return this.list(threadId, input.repository);
    if (input.action === "select") return this.select(threadId, required(input.worktreeId, "worktreeId"));
    throw new Error("worktree action must be create, list, or select");
  }

  /** Resolve execution cwd from the durable root selection and current Git topology. */
  async resolveCwd(request: ResolveWorktreeCwdRequest): Promise<ResolveWorktreeCwdResult> {
    const threadId = required(request?.threadId, "threadId");
    const fallbackCwd = required(request?.fallbackCwd, "fallbackCwd");
    if (!isAbsolute(fallbackCwd)) throw new Error("fallbackCwd must be an absolute path");
    const selected = this.state.selectedWorktree(threadId);
    if (!selected) return { cwd: fallbackCwd, selected: false };
    try {
      assertExactWorktree(await this.git.inspectWorktree(selected.path), selected);
    } catch (error) {
      throw new Error(
        `selected worktree is unavailable or has changed Git identity: ${selected.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return { cwd: selected.path, selected: true, worktreeId: selected.id };
  }

  private async create(
    threadId: string,
    input: Extract<UseWorktreeInput, { action: "create" }>,
  ): Promise<Extract<UseWorktreeResult, { action: "create" }>> {
    const repositoryPath = required(input.repository, "repository");
    if (!isAbsolute(repositoryPath)) throw new Error("repository must be an absolute path inside an existing Git repository");
    const name = required(input.name, "name");
    const repository = await this.git.resolveRepository(repositoryPath);
    const requestedTarget = worktreeTarget(this.ooHome, repository.repository, name);
    let targetPath = requestedTarget.path;
    let created = false;

    if (existsSync(targetPath)) {
      if (realpathSync.native(targetPath) !== targetPath) {
        throw new Error(`existing worktree path is not canonical: ${targetPath}`);
      }
      assertExactWorktree(await this.git.inspectWorktree(targetPath), {
        path: targetPath,
        repository: repository.repository,
        gitCommonDir: repository.gitCommonDir,
        branch: name,
      });
    } else {
      mkdirSync(dirname(targetPath), { recursive: true });
      const canonicalRoot = realpathSync.native(requestedTarget.root);
      targetPath = resolve(realpathSync.native(dirname(targetPath)), basename(targetPath));
      if (!isChildPath(canonicalRoot, targetPath)) {
        throw new Error("worktree target resolves outside its Owner Operator repository directory");
      }
      await this.git.createWorktree(repository, targetPath, name, input.base);
      created = true;
      assertExactWorktree(await this.git.inspectWorktree(targetPath), {
        path: targetPath,
        repository: repository.repository,
        gitCommonDir: repository.gitCommonDir,
        branch: name,
      });
    }

    let worktree: RegisteredWorktree;
    try {
      worktree = this.state.registerAndSelectWorktree(threadId, {
        repository: repository.repository,
        path: targetPath,
        gitCommonDir: repository.gitCommonDir,
      });
    } catch (error) {
      throw new Error(
        `worktree exists but is unselected at ${targetPath}: State persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return { action: "create", created, worktree: { ...worktree, available: true, selected: true } };
  }

  private async list(
    threadId: string,
    repository?: string,
  ): Promise<Extract<UseWorktreeResult, { action: "list" }>> {
    if (repository !== undefined && (typeof repository !== "string" || !repository.trim())) {
      throw new Error("repository filter must be a non-empty string");
    }
    const selectedId = this.state.selectedWorktree(threadId)?.id;
    const rows = this.state.listWorktrees(repository?.trim());
    const worktrees = await Promise.all(rows.map(async (row): Promise<WorktreeInfo> => ({
      ...row,
      available: await this.available(row),
      selected: row.id === selectedId,
    })));
    return { action: "list", worktrees };
  }

  private async select(
    threadId: string,
    worktreeId: string,
  ): Promise<Extract<UseWorktreeResult, { action: "select" }>> {
    const registered = this.state.worktreeById(worktreeId);
    if (!registered) throw new Error(`worktree not found: ${worktreeId}`);
    let inspection: GitWorktreeInspection;
    try {
      inspection = await this.git.inspectWorktree(registered.path);
      assertExactWorktree(inspection, registered);
    } catch (error) {
      throw new Error(
        `registered worktree is unavailable or has changed Git identity: ${registered.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    const selected = this.state.selectWorktree(threadId, worktreeId);
    return { action: "select", worktree: { ...selected, available: true, selected: true } };
  }

  private async available(worktree: RegisteredWorktree): Promise<boolean> {
    try {
      assertExactWorktree(await this.git.inspectWorktree(worktree.path), worktree);
      return true;
    } catch {
      return false;
    }
  }
}

/** Immutable Owner Operator creation provenance for one Git linked worktree. Mutable Git facts
 * (branch, HEAD, dirty state, and live topology) are deliberately absent. */
export interface RegisteredWorktree {
  id: string;
  repository: string;
  path: string;
  gitCommonDir: string;
  createdByThreadId: string;
  createdAt: string;
}

/** Registered provenance plus a fresh Git-topology observation for one calling root. */
export interface WorktreeInfo extends RegisteredWorktree {
  available: boolean;
  selected: boolean;
}

export type UseWorktreeInput =
  | { action: "create"; repository: string; name: string; base?: string }
  | { action: "list"; repository?: string }
  | { action: "select"; worktreeId: string };

/** Trusted caller identity travels beside the model-authored operation. */
export interface UseWorktreeRequest {
  threadId: string;
  input: UseWorktreeInput;
}

export type UseWorktreeResult =
  | { action: "create"; created: boolean; worktree: WorktreeInfo }
  | { action: "list"; worktrees: WorktreeInfo[] }
  | { action: "select"; worktree: WorktreeInfo };

/** Resolve one root's execution cwd without changing its durable selection. */
export interface ResolveWorktreeCwdRequest {
  threadId: string;
  fallbackCwd: string;
}

export type ResolveWorktreeCwdResult =
  | { cwd: string; selected: false }
  | { cwd: string; selected: true; worktreeId: string };

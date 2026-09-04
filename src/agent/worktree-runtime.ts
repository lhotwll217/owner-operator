import type {
  ExtensionContext,
  ExtensionFactory,
  SessionStartEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { GatewayApi } from "@owner-operator/core";
import { resolveBackend } from "../gateway/client";
import { normalizeEmptyOoReplacementSession, type OoProvenance } from "./agent";

type WorktreeCwdGateway = Pick<GatewayApi, "resolveWorktreeCwd">;

export interface ResolveOwnerOperatorTaskCwdOptions {
  resolveGateway?: () => Promise<WorktreeCwdGateway>;
}

/** The only client-side path from stable OO session identity to an execution cwd. */
export async function resolveOwnerOperatorTaskCwd(
  sessionManager: Pick<SessionManager, "getSessionId">,
  fallbackCwd: string,
  options: ResolveOwnerOperatorTaskCwdOptions = {},
): Promise<string> {
  const gateway = await (options.resolveGateway ?? resolveBackend)();
  return (await gateway.resolveWorktreeCwd({
    threadId: sessionManager.getSessionId(),
    fallbackCwd,
  })).cwd;
}

export async function resolveInteractiveRuntimeTarget(
  sessionManager: SessionManager,
  sessionStartEvent: SessionStartEvent | undefined,
  provenance: OoProvenance,
  fallbackCwd: string,
  options: ResolveOwnerOperatorTaskCwdOptions = {},
): Promise<{ cwd: string; sessionManager: SessionManager }> {
  const piCreatedEmptyManager = sessionStartEvent?.reason === "new"
    || (sessionStartEvent?.reason === "fork" && sessionManager.getEntries().length === 0);
  const stableSessionManager = piCreatedEmptyManager
    ? normalizeEmptyOoReplacementSession(sessionManager, provenance)
    : sessionManager;
  return {
    cwd: await resolveOwnerOperatorTaskCwd(stableSessionManager, fallbackCwd, options),
    sessionManager: stableSessionManager,
  };
}

/** Selection is recorded during tool execution; runtime replacement consumes it once the entire
 * agent run has settled. A set handles a session being selected more than once in one turn. */
export class PendingWorktreeCwdChanges {
  private readonly threadIds = new Set<string>();

  record(threadId: string): void {
    this.threadIds.add(threadId);
  }

  take(threadId: string): boolean {
    if (!this.threadIds.has(threadId)) return false;
    this.threadIds.delete(threadId);
    return true;
  }

  has(threadId: string): boolean {
    return this.threadIds.has(threadId);
  }

  discard(threadId: string): void {
    this.threadIds.delete(threadId);
  }
}

/** Prevents a settling outgoing turn from starting a nested replacement while Pi is already
 * replacing that session for /new, /resume, or /fork. */
export class InteractiveSessionReplacement {
  private threadId: string | undefined;

  begin(threadId: string): void {
    this.threadId = threadId;
  }

  includes(threadId: string): boolean {
    return this.threadId === threadId;
  }

  complete(): string | undefined {
    const threadId = this.threadId;
    this.threadId = undefined;
    return threadId;
  }
}

export interface WorktreeRuntimeRebindOptions {
  pending: PendingWorktreeCwdChanges;
  replacement: InteractiveSessionReplacement;
  rebind: (threadId: string) => Promise<void>;
}

/** Pi's agent_settled boundary runs after retries, compaction, and queued continuations. */
export function createWorktreeRuntimeRebindExtension(
  options: WorktreeRuntimeRebindOptions,
): ExtensionFactory {
  return (pi) => {
    const beginReplacement = (_event: unknown, ctx: ExtensionContext): void => {
      options.replacement.begin(ctx.sessionManager.getSessionId());
    };
    pi.on("session_before_switch", beginReplacement);
    pi.on("session_before_fork", beginReplacement);
    pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
      const threadId = ctx.sessionManager.getSessionId();
      if (options.replacement.includes(threadId)) return;
      if (!options.pending.take(threadId)) return;
      try {
        await options.rebind(threadId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Selected worktree could not be activated: ${message}`, "error");
      }
    });
  };
}

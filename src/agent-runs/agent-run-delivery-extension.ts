import type { GatewayApi } from "@owner-operator/core";
import type { ParentAgentStateView } from "@owner-operator/core/agent-state";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { resolveBackend } from "../gateway/client";
import {
  AGENT_RUN_COMPLETION_MESSAGE_TYPE,
  PiParentCompletionAdapter,
  renderAgentRunCompletionMessage,
} from "./agent-run-completion";
import { ParentRunSession, gatewayParentRunAdapter } from "./parent-run-session";

interface AgentRunDeliveryExtensionOptions {
  resolveGateway?: () => Promise<GatewayApi>;
  onUnavailable?: (error: unknown) => void;
}

interface AgentRunDeliveryRegistrationOptions {
  resolveGateway?: () => Promise<GatewayApi>;
  successBatchDelayMs?: number;
  retryDelayMs?: number;
  onView?: (view: ParentAgentStateView, ctx: ExtensionContext) => void;
  onUnavailable?: (error: unknown, ctx: ExtensionContext) => void;
  onDisconnected?: (ctx: ExtensionContext) => void;
  onStopped?: (ctx: ExtensionContext) => void;
}

export interface AgentRunDeliveryRegistration {
  readonly session: ParentRunSession | undefined;
}

/** Shared Pi lifecycle for parent-scoped completion delivery on every conversation surface. */
export function registerAgentRunDelivery(
  pi: ExtensionAPI,
  options: AgentRunDeliveryRegistrationOptions = {},
): AgentRunDeliveryRegistration {
  const getGateway = options.resolveGateway ?? resolveBackend;
  pi.registerMessageRenderer(AGENT_RUN_COMPLETION_MESSAGE_TYPE, renderAgentRunCompletionMessage);
  let session: ParentRunSession | undefined;
  let unsubscribeView: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const stopSession = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    unsubscribeView?.();
    unsubscribeView = undefined;
    session?.stop();
    session = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    const ownGeneration = generation;
    stopSession();
    let notified = false;
    const start = async (): Promise<void> => {
      if (ownGeneration !== generation) return;
      let candidate: ParentRunSession | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        const gateway = await getGateway();
        if (ownGeneration !== generation) return;
        candidate = new ParentRunSession(ctx.sessionManager.getSessionId(), gatewayParentRunAdapter(gateway), {
          completionAdapter: new PiParentCompletionAdapter(pi, ctx.sessionManager),
          onDisconnected: () => {
            if (ownGeneration === generation) options.onDisconnected?.(ctx);
          },
          ...(options.successBatchDelayMs === undefined ? {} : { successBatchDelayMs: options.successBatchDelayMs }),
        });
        if (options.onView) {
          unsubscribe = candidate.subscribe((view) => {
            if (ownGeneration !== generation) return;
            options.onView?.(view, ctx);
          });
        }
        await candidate.start();
        await candidate.settled();
        if (ownGeneration !== generation) {
          unsubscribe?.();
          candidate.stop();
          return;
        }
        session = candidate;
        unsubscribeView = unsubscribe;
      } catch (error) {
        unsubscribe?.();
        candidate?.stop();
        if (ownGeneration !== generation) return;
        stopSession();
        if (!notified) {
          notified = true;
          options.onUnavailable?.(error, ctx);
        }
        if (options.retryDelayMs === undefined) throw error;
        retryTimer = setTimeout(() => { void start(); }, options.retryDelayMs);
      }
    };
    await start();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    generation += 1;
    await session?.settled();
    stopSession();
    options.onStopped?.(ctx);
  });

  return {
    get session() { return session; },
  };
}

/** Surface-independent completion delivery for short-lived, non-TUI Pi sessions. */
export function createAgentRunDeliveryExtension(
  options: AgentRunDeliveryExtensionOptions = {},
): ExtensionFactory {
  return (pi) => {
    registerAgentRunDelivery(pi, {
      resolveGateway: options.resolveGateway,
      successBatchDelayMs: 0,
      onUnavailable: (error) => options.onUnavailable?.(error),
    });
  };
}

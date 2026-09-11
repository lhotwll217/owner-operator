import type { GatewayApi } from "@owner-operator/core";
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
  onUnavailable?: (error: unknown, ctx: ExtensionContext) => void;
}

/** Shared Pi lifecycle for parent-scoped completion delivery on every conversation surface. */
export function registerAgentRunDelivery(
  pi: ExtensionAPI,
  options: AgentRunDeliveryRegistrationOptions = {},
): void {
  const getGateway = options.resolveGateway ?? resolveBackend;
  pi.registerMessageRenderer(AGENT_RUN_COMPLETION_MESSAGE_TYPE, renderAgentRunCompletionMessage);
  let session: ParentRunSession | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const stopSession = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
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
      try {
        const gateway = await getGateway();
        if (ownGeneration !== generation) return;
        candidate = new ParentRunSession(ctx.sessionManager.getSessionId(), gatewayParentRunAdapter(gateway), {
          completionAdapter: new PiParentCompletionAdapter(pi, ctx.sessionManager),
          ...(options.successBatchDelayMs === undefined ? {} : { successBatchDelayMs: options.successBatchDelayMs }),
        });
        await candidate.start();
        await candidate.settled();
        if (ownGeneration !== generation) {
          candidate.stop();
          return;
        }
        session = candidate;
      } catch (error) {
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

  pi.on("session_shutdown", async () => {
    generation += 1;
    await session?.settled();
    stopSession();
  });
}

export function createInteractiveAgentRunDeliveryExtension(
  options: AgentRunDeliveryRegistrationOptions = {},
): ExtensionFactory {
  return (pi) => {
    registerAgentRunDelivery(pi, {
      retryDelayMs: 1_000,
      onUnavailable: (error, ctx) => {
        ctx.ui.notify(`Agent completion delivery unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      },
      ...options,
    });
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

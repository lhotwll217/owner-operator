import type { GatewayApi } from "@owner-operator/core";
import type { AgentRunView, ParentAgentStateView } from "@owner-operator/core/agent-state";
import {
  type ExtensionAPI,
  type ExtensionFactory,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { resolveBackend } from "../gateway/client";
import {
  AGENT_RUN_COMPLETION_MESSAGE_TYPE,
  PiParentCompletionAdapter,
  renderAgentRunCompletionMessage,
} from "./agent-run-completion";
import { formatAgentElapsed } from "./format-agent-elapsed";
import { ParentRunSession, gatewayParentRunAdapter } from "./parent-run-session";

export { formatAgentElapsed } from "./format-agent-elapsed";

export type AgentStatePickerAction =
  | { kind: "close" }
  | { kind: "cancel"; runId: string }
  | { kind: "resume"; runId: string };

function statusColor(theme: Theme, run: AgentRunView): string {
  const value = `${run.status.glyph} ${run.status.text}`;
  if (run.category === "attention") return theme.fg("warning", value);
  if (run.status.text === "running") return theme.fg("accent", value);
  if (run.status.text === "completed") return theme.fg("success", value);
  return theme.fg("muted", value);
}

/** Focused, surface-only component. All lifecycle meaning arrives in ParentAgentStateView. */
export class AgentStatePicker {
  private selectedIndex = 0;

  constructor(
    private view: ParentAgentStateView,
    private readonly theme: Theme,
    private readonly onAction: (action: AgentStatePickerAction) => void,
    private readonly requestRender: () => void,
  ) {}

  update(view: ParentAgentStateView): void {
    const selectedId = this.selected?.id;
    this.view = view;
    const nextIndex = selectedId ? view.runs.findIndex(({ id }) => id === selectedId) : -1;
    this.selectedIndex = nextIndex >= 0 ? nextIndex : Math.min(this.selectedIndex, Math.max(0, view.runs.length - 1));
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onAction({ kind: "close" });
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.move(1);
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.move(-1);
      return;
    }
    const selected = this.selected;
    if (data === "c" && selected?.canCancel) {
      this.onAction({ kind: "cancel", runId: selected.id });
    } else if (data === "r" && selected?.canResume) {
      this.onAction({ kind: "resume", runId: selected.id });
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const line = (value: string): string => truncateToWidth(value, safeWidth);
    const lines: string[] = [line(this.theme.fg("accent", this.theme.bold("Agent state"))), ""];
    if (!this.view.runs.length) {
      lines.push(line(this.theme.fg("muted", "No delegated agents")));
      lines.push("", line(this.theme.fg("dim", "esc close")));
      return lines;
    }

    const visibleCount = Math.min(8, this.view.runs.length);
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(visibleCount / 2),
      this.view.runs.length - visibleCount,
    ));
    for (let index = start; index < start + visibleCount; index += 1) {
      const run = this.view.runs[index]!;
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "› Selected · ") : "  ";
      const task = selected ? this.theme.fg("text", run.task) : this.theme.fg("muted", run.task);
      const wideContext = safeWidth >= 60 ? ` · ${run.harness} · ${formatAgentElapsed(run.elapsedMs)}` : "";
      lines.push(line(`${prefix}${statusColor(this.theme, run)} · ${task}${this.theme.fg("dim", wideContext)}`));
    }

    const selected = this.selected!;
    lines.push("", line(this.theme.fg("borderMuted", "─".repeat(safeWidth))));
    lines.push(line(`${this.theme.fg("dim", "Task:")} ${selected.task}`));
    lines.push(line(`${this.theme.fg("dim", "Harness:")} ${selected.harness}`));
    lines.push(line(`${this.theme.fg("dim", "Status:")} ${statusColor(this.theme, selected)}`));
    lines.push(line(`${this.theme.fg("dim", "Elapsed:")} ${formatAgentElapsed(selected.elapsedMs)}`));
    lines.push(line(`${this.theme.fg("dim", "Activity:")} ${selected.latestActivity || "No activity yet"}`));
    const controls = ["↑/↓ select", selected.canCancel ? "c cancel" : "", selected.canResume ? "r resume" : "", "esc close"]
      .filter(Boolean)
      .join(" · ");
    lines.push("", line(this.theme.fg("dim", controls)));
    return lines;
  }

  invalidate(): void {}

  private get selected(): AgentRunView | undefined {
    return this.view.runs[this.selectedIndex];
  }

  private move(delta: number): void {
    if (!this.view.runs.length) return;
    this.selectedIndex = (this.selectedIndex + delta + this.view.runs.length) % this.view.runs.length;
    this.requestRender();
  }
}

interface AgentStateExtensionOptions {
  resolveGateway?: () => Promise<GatewayApi>;
  retryDelayMs?: number;
}

/** Pi adapter: a literal footer/status entry plus the `/agent-state` focused picker. */
export function createAgentStateExtension(options: AgentStateExtensionOptions = {}): ExtensionFactory {
  const getGateway = options.resolveGateway ?? resolveBackend;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  return (pi: ExtensionAPI) => {
    pi.registerMessageRenderer(AGENT_RUN_COMPLETION_MESSAGE_TYPE, renderAgentRunCompletionMessage);
    let session: ParentRunSession | undefined;
    let unsubscribeView: (() => void) | undefined;
    let picker: AgentStatePicker | undefined;
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
          });
          unsubscribe = candidate.subscribe((view) => {
            if (ownGeneration !== generation) return;
            ctx.ui.setStatus("agent-state", view.footer ?? undefined);
            picker?.update(view);
          });
          await candidate.start();
          if (ownGeneration !== generation) {
            unsubscribe();
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
          ctx.ui.setStatus("agent-state", undefined);
          if (!notified) {
            notified = true;
            ctx.ui.notify(`Agent state unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
          retryTimer = setTimeout(() => { void start(); }, retryDelayMs);
        }
      };
      await start();
    });

    pi.on("session_shutdown", (_event, ctx) => {
      generation += 1;
      picker = undefined;
      stopSession();
      ctx.ui.setStatus("agent-state", undefined);
    });

    pi.registerCommand("agent-state", {
      description: "Inspect and control delegated agents for this thread",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/agent-state requires interactive mode", "error");
          return;
        }
        if (!session) {
          ctx.ui.notify("Agent state is unavailable", "warning");
          return;
        }
        const selected = await ctx.ui.custom<AgentStatePickerAction>((tui, theme, _keybindings, done) => {
          picker = new AgentStatePicker(session!.view, theme, done, () => tui.requestRender());
          return picker;
        });
        picker = undefined;
        if (selected.kind === "close") return;
        const run = session.view.runs.find(({ id }) => id === selected.runId);
        try {
          if (selected.kind === "cancel") {
            const confirmed = await ctx.ui.confirm(
              "Cancel delegated agent?",
              run ? `${run.status.glyph} ${run.status.text} · ${run.harness} · ${run.task}` : selected.runId,
            );
            if (!confirmed) return;
            await session.cancel(selected.runId);
          } else {
            await session.resume(selected.runId);
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export const agentStateExtension = createAgentStateExtension();

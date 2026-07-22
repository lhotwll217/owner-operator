import type { GatewayApi } from "@owner-operator/core";
import {
  formatAgentRunIdentity,
  type AgentRunView,
  type ParentAgentStateView,
} from "@owner-operator/core/agent-state";
import {
  type ExtensionAPI,
  type ExtensionFactory,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { registerAgentRunDelivery } from "./agent-run-delivery-extension";
import { formatAgentElapsed } from "./format-agent-elapsed";

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
  private inspecting = false;

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
    if (!this.selected) this.inspecting = false;
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.inspecting) {
        this.inspecting = false;
        this.requestRender();
        return;
      }
      this.onAction({ kind: "close" });
      return;
    }
    if (matchesKey(data, "enter") && this.selected) {
      this.inspecting = true;
      this.requestRender();
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

    if (this.inspecting) {
      const selected = this.selected!;
      lines.push(line(`${statusColor(this.theme, selected)} · ${this.theme.fg("text", selected.task)}`));
      lines.push("", line(this.theme.fg("borderMuted", "─".repeat(safeWidth))));
      lines.push(line(`${this.theme.fg("dim", "Task:")} ${selected.task}`));
      lines.push(line(`${this.theme.fg("dim", "Harness:")} ${formatAgentRunIdentity(selected.harness, selected.model)}`));
      lines.push(line(`${this.theme.fg("dim", "Status:")} ${statusColor(this.theme, selected)}`));
      lines.push(line(`${this.theme.fg("dim", "Elapsed:")} ${formatAgentElapsed(selected.elapsedMs)}`));
      lines.push(line(`${this.theme.fg("dim", "Activity:")} ${selected.latestActivity || "No activity yet"}`));
      const controls = [selected.canCancel ? "c cancel" : "", selected.canResume ? "r resume" : "", "esc back"]
        .filter(Boolean)
        .join(" · ");
      lines.push("", line(this.theme.fg("dim", controls)));
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
      const wideContext = safeWidth >= 60
        ? ` · ${formatAgentRunIdentity(run.harness, run.model)} · ${formatAgentElapsed(run.elapsedMs)}`
        : "";
      lines.push(line(`${prefix}${statusColor(this.theme, run)} · ${task}${this.theme.fg("dim", wideContext)}`));
    }

    const selected = this.selected!;
    const controls = ["↑/↓ select", selected.canCancel ? "c cancel" : "", selected.canResume ? "r resume" : "", "esc close"]
      .filter(Boolean)
      .join(" · ");
    lines.push("", line(this.theme.fg("dim", `enter inspect · ${controls}`)));
    return lines;
  }

  invalidate(): void {}

  private get selected(): AgentRunView | undefined {
    return this.view.runs[this.selectedIndex];
  }

  private move(delta: number): void {
    if (!this.view.runs.length) return;
    this.inspecting = false;
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
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  return (pi: ExtensionAPI) => {
    let picker: AgentStatePicker | undefined;
    const delivery = registerAgentRunDelivery(pi, {
      resolveGateway: options.resolveGateway,
      retryDelayMs,
      onView: (view, ctx) => {
        ctx.ui.setStatus("agent-state", view.footer ?? undefined);
        picker?.update(view);
      },
      onUnavailable: (error, ctx) => {
        ctx.ui.setStatus("agent-state", undefined);
        ctx.ui.notify(`Agent state unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      },
      onStopped: (ctx) => {
        picker = undefined;
        ctx.ui.setStatus("agent-state", undefined);
      },
    });

    pi.registerCommand("agent-state", {
      description: "Inspect and control delegated agents for this thread",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/agent-state requires interactive mode", "error");
          return;
        }
        const session = delivery.session;
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
              run
                ? `${run.status.glyph} ${run.status.text} · ${run.task} · ${formatAgentRunIdentity(run.harness, run.model)}`
                : selected.runId,
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

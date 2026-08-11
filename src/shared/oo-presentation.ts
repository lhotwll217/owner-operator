// Owner Operator — the single presentation seam for the interactive terminal surface.
//
// This adapter owns the choices that make bare `./oo` read as Owner Operator instead of
// stock pi: the identity marker, palette/theme, delegated-run lifecycle rows, and silent start.
// pi-tool-display separately owns ordinary tool and thinking presentation.
//
// pi hooks used (see pi's docs/extensions.md + docs/tui.md, shipped in the package):
//   ctx.ui.setTheme — Owner Operator styling.
//
// The startup banner is silenced through the supported `quietStartup` setting (.pi/settings.json).

import type { AgentRun, AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { formatAgentRunIdentity } from "@owner-operator/core/agent-state";
import {
  Theme,
  type ExtensionFactory,
  type InteractiveModeOptions,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";

// ---- Identity ------------------------------------------------------------------------
// A light marker, not a banner: one quiet line on start. Deliberately carries no pi
// branding — the whole point of the surface is that it reads as Owner Operator.
export const OO_NAME = "Owner Operator";

/** The one quiet identity line printed on start, e.g. "Owner Operator v0.0.0". */
export function ooMarker(version: string): string {
  return `${OO_NAME} v${version}`;
}

// ---- Palette & theme -----------------------------------------------------------------
// A deliberate, minimal OO palette: one accent + muted greys for the chrome. Functional
// signals (success/error/warning) and syntax highlighting stay legible — decluttering the
// branding, not the information. These values are OO's own; they don't track pi's theme.
export const ooPalette = {
  accent: "#b98a4b", // the single OO accent — a restrained bronze, distinct from pi's teal
  text: "#cfd2d6", // primary foreground
  muted: "#8b9099", // secondary / tool output
  dim: "#5b606b", // tertiary / borders / hints
  faint: "#3c4048", // faint chrome (thinking-off, muted borders)
} as const;

// The full color map pi's TUI needs — typed against ThemeColor so a missing token is a
// compile error. Chrome is neutralized to the OO greys + one accent; status and syntax
// colors are kept so results stay readable.
const OO_FG_COLORS: Record<ThemeColor, string> = {
  accent: ooPalette.accent,
  border: ooPalette.dim,
  borderAccent: ooPalette.accent,
  borderMuted: ooPalette.faint,
  success: "#b5bd68",
  error: "#cc6666",
  warning: "#e0af68",
  muted: ooPalette.muted,
  dim: ooPalette.dim,
  text: ooPalette.text,
  thinkingText: ooPalette.muted,
  userMessageText: ooPalette.text,
  customMessageText: ooPalette.text,
  customMessageLabel: ooPalette.muted,
  toolTitle: ooPalette.text,
  toolOutput: ooPalette.muted,
  mdHeading: ooPalette.accent,
  mdLink: "#81a2be",
  mdLinkUrl: ooPalette.dim,
  mdCode: ooPalette.accent,
  mdCodeBlock: ooPalette.text,
  mdCodeBlockBorder: ooPalette.faint,
  mdQuote: ooPalette.muted,
  mdQuoteBorder: ooPalette.faint,
  mdHr: ooPalette.faint,
  mdListBullet: ooPalette.accent,
  toolDiffAdded: "#b5bd68",
  toolDiffRemoved: "#cc6666",
  toolDiffContext: ooPalette.muted,
  syntaxComment: "#6A9955",
  syntaxKeyword: "#569CD6",
  syntaxFunction: "#DCDCAA",
  syntaxVariable: "#9CDCFE",
  syntaxString: "#CE9178",
  syntaxNumber: "#B5CEA8",
  syntaxType: "#4EC9B0",
  syntaxOperator: "#D4D4D4",
  syntaxPunctuation: "#D4D4D4",
  thinkingOff: ooPalette.faint,
  thinkingMinimal: "#6e6e6e",
  thinkingLow: "#5f87af",
  thinkingMedium: "#81a2be",
  thinkingHigh: "#b294bb",
  thinkingXhigh: "#d183e8",
  thinkingMax: "#ef9aeb",
  bashMode: ooPalette.accent,
};

const OO_BG_COLORS: Record<string, string> = {
  selectedBg: "#33353b",
  userMessageBg: "#2b2d33",
  customMessageBg: "#2b2d33",
  toolPendingBg: "#262626",
  toolSuccessBg: "#262626",
  toolErrorBg: "#352727",
};

/** Build the OO theme. `mode` should follow the terminal's color support. */
export function buildOoTheme(mode: "truecolor" | "256color" = "truecolor"): Theme {
  return new Theme(OO_FG_COLORS, OO_BG_COLORS as ConstructorParameters<typeof Theme>[1], mode, {
    name: "owner-operator",
  });
}

// ---- Delegated-run fallback serialization --------------------------------------------------
// These helpers keep delegated-run lifecycle rows bounded and free of activity, result, failure,
// or retry bodies. Ordinary tool components are owned separately by pi-tool-display.

/** The wire AgentRun fields read by the compact terminal presentation. */
export interface AgentRunRowView {
  harness?: AgentRunHarness;
  model?: string | null;
  effort?: AgentRun["effort"];
  task?: string;
  status?: AgentRunStatus;
  createdAt?: string | null;
  finishedAt?: string | null;
}

/** Human elapsed between two ISO stamps, e.g. "2m 3s". Empty when either is missing. */
export function elapsedLabel(fromIso?: string | null, toIso?: string | null): string {
  if (!fromIso || !toIso) return "";
  const durationMs = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(durationMs) ? formatElapsedDuration(durationMs) : "";
}

function formatElapsedDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** One compact line for a delegated run. Activity/result/error bodies never enter this view. */
export function formatAgentRunRow(run: AgentRunRowView, nowIso?: string): string {
  const parts: string[] = [];
  if (run.harness) parts.push(formatAgentRunIdentity(run.harness, run.model ?? null, run.effort ?? null));
  if (run.task) parts.push(truncate(run.task, 60));
  if (run.status) parts.push(run.status);
  const elapsed = elapsedLabel(run.createdAt, run.finishedAt ?? nowIso ?? null);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// ---- Silent start --------------------------------------------------------------------
// Decision §5: no auto model turn. The interactive surface opens fully silent — no
// `initialMessage`. The owner asks; the ranked thread list lives in the widget (and
// `oo --session-state`), so there's no canned brief to re-narrate that deterministic state.
export function ooInteractiveOptions(): InteractiveModeOptions {
  return {};
}

// ---- The presentation extension ------------------------------------------------------
// Installs the OO theme; package-owned tool rows and completion messages render separately.
export const ooPresentationExtension: ExtensionFactory = (pi) => {
  pi.on("session_start", (_event, ctx) => {
    const mode = ctx.ui.theme.getColorMode();
    ctx.ui.setTheme(buildOoTheme(mode));
  });
};

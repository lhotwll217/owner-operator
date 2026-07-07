// Owner Operator first-run onboarding — a pi extension (like privacy-tools). It runs the guided
// setup once, the first time the terminal surface starts with a TTY, and is also available on
// demand as `/onboarding`. The write half + detection live in @owner-operator/core; this is the
// interactive flow over pi's own ctx.ui dialogs.
//
// Shape follows OpenClaw's onboarding (docs/inspiration.md): DETECT-THEN-VERIFY. We don't ask
// "which tools do you use?" — we scan the default roots and show what's there. The only real
// question is privacy (off-limits paths), asked BEFORE the first read. Sources are confirmed,
// not configured. The flow hands off to the session's own first turn, which is the real reveal
// (the ranked list), so onboarding stays short and never reinvents the ranking UI.

import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  KNOWN_SESSION_SOURCES,
  addBlacklistEntries,
  addSessionRoot,
  detectSources,
  isOnboarded,
  markOnboarded,
  saveActiveWindow,
  summarizeDetectedSources,
} from "@owner-operator/core";

const ooHome = (): string => process.env.OO_HOME ?? path.join(homedir(), ".owner-operator");

// Re-entrancy guard: session_start can fire more than once in a process (reload/new). We only
// auto-run on a fresh "startup", but belt-and-suspenders so a second call is a no-op.
let running = false;

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p);

// Split a free-form "off-limits" answer into absolute-ish paths: comma/newline separated, ~ expanded.
function parsePaths(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => expandHome(s.trim()))
    .filter(Boolean);
}

/**
 * Walk the owner through setup, writing config as we go. Safe to call from either the first-run
 * gate or the `/onboarding` command. No-ops without a UI (headless `oo "question"` must never
 * block on a dialog). `force` re-runs even when already onboarded (the explicit command).
 */
export async function runOnboarding(ctx: ExtensionContext, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (running) return;
  if (!ctx.hasUI) return;
  if (!force && isOnboarded(ooHome())) return;
  running = true;
  const ui = ctx.ui;
  try {
    // 1. What it is, then consent. One honest clause on the read — no overclaim, no lecture.
    const go = await ui.confirm(
      "Owner Operator",
      "I watch the coding-agent sessions already on this Mac and rank them by what needs you — " +
        "read locally, no full transcripts sent to a model.\n\nSet up now?",
    );
    if (!go) {
      ui.notify("No problem — run /onboarding when you're ready.", "info");
      return;
    }

    // 2. Privacy FIRST, before any read. The one decision only the owner can make.
    const offLimits = await ui.input(
      "Anything off-limits?",
      "repos or paths I should never read — comma-separated, blank for none",
    );
    const paths = offLimits ? parsePaths(offLimits) : [];
    if (paths.length) {
      addBlacklistEntries(ooHome(), { paths });
      ui.notify(`Won't touch ${paths.length} path(s). Change anytime in ${path.join(ooHome(), "blacklist.json")}.`, "info");
    }

    // 3. Detect sources — no questions, just show what's on disk.
    const found = summarizeDetectedSources(detectSources(ooHome())).filter((s) => s.exists && s.count > 0);
    if (found.length) {
      ui.notify(`Found sessions from: ${found.map((s) => `${s.source} (${s.count})`).join(" · ")}`, "info");
    } else {
      // Nothing at the default roots — offer the manual add (OpenClaw's fallback).
      ui.notify("No sessions at the default locations.", "warning");
      const add = await ui.confirm("Sessions elsewhere?", "Point me at a folder where your agent sessions live?");
      if (add) {
        const source = await ui.select("Which agent?", [...KNOWN_SESSION_SOURCES]);
        const root = source ? await ui.input(`Path to ${source} sessions`, "e.g. /Volumes/ext/claude") : undefined;
        if (source && root?.trim()) {
          addSessionRoot(ooHome(), source, expandHome(root.trim()));
          ui.notify(`Added ${source} at ${expandHome(root.trim())}.`, "info");
        }
      }
    }

    // 4. Active window — a sensible default, one tap to change. Low stakes, so keep it optional.
    const window = await ui.select("How far back counts as “active”?", ["1d (default)", "36h", "3d", "7d"]);
    if (window && !window.startsWith("1d")) saveActiveWindow(ooHome(), window.split(" ")[0]);

    // 5. Mark done and hand off. The session's own first turn is the reveal (the ranked list),
    // so we don't render it here — we point at the surfaces and let it flow.
    markOnboarded(ooHome(), { via: force ? "command" : "first-run" });
    ui.notify(
      "Set up. I'll keep watching in the background. " +
        "Open the always-on panel with `make run` in apps/widget, or just ask — " +
        "next time you start a session in any of these, watch it show up.",
      "info",
    );
  } finally {
    running = false;
  }
}

/** The pi extension: register `/onboarding` and auto-run the flow on a fresh first-run startup. */
export const onboardingExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerCommand("onboarding", {
    description: "Guided first-run setup: privacy, session sources, and the widget.",
    handler: async (_args, ctx) => {
      await runOnboarding(ctx, { force: true });
    },
  });

  pi.on("session_start", async (event, ctx) => {
    // Only the very first launch — never on reload/new/resume/fork, and only when not yet onboarded.
    if (event.reason !== "startup") return;
    await runOnboarding(ctx);
  });
};

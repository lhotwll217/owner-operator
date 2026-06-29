// Owner Operator — the startup chat brief. The chat is the FOCUSED "what to do next"
// surface; the sidebar is the complete, live list. This renders a one-line landscape
// summary plus only the threads that need the owner NOW (most-urgent first) — never a card
// per thread, which would just mirror the sidebar. Built from the SAME snapshot+triage the sidebar
// joins, so its counts can't contradict the sidebar. Kept separate from tui.ts so it previews
// without a live terminal (see brief.preview.ts).

import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { stateCounts, displayTopic, type SidebarThread } from "@owner-operator/core";

type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), cyan = sgr(36), yellow = sgr(33), green = sgr(32), gray = sgr(90), red = sgr(1, 31);

// Priority color — same mapping as the sidebar and the cards (5 loudest → 1 fades).
const prio = (p: number): Styler => (p >= 5 ? red : p === 4 ? yellow : p === 3 ? cyan : gray);

const MAX_W = 96;     // don't stretch across an ultra-wide terminal
const FOCUS_CAP = 4;  // inline needs-you items; the rest is surfaced as "+N more" (no silent cap)

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * The focused startup brief: a landscape summary line, then the few threads waiting on the
 * owner, loudest-first. Everything else lives in the sidebar. Returns ANSI lines (callers strip
 * color when piping). Empty → a single notice, same as the sidebar.
 */
export function buildBrief(threads: readonly SidebarThread[], width: number): string[] {
  const W = Math.max(40, Math.min(width, MAX_W));
  const active = threads.filter((t) => t.active);
  if (!active.length) return [dim("(no active threads)")];

  const counts = stateCounts(active);
  const projects = new Set(active.map((t) => t.repo)).size;

  // Headline: total + project count, then the state mix (zero buckets omitted). Count colors
  // match the sidebar's stats line so the chat and the sidebar read as one system.
  const mix = [
    counts["needs-you"] && yellow(`${counts["needs-you"]} need you`),
    counts.working && green(`${counts.working} working`),
    counts.idle && gray(`${counts.idle} idle`),
  ].filter(Boolean).join(dim(", "));
  const out: string[] = [
    bold(`▸ ${plural(active.length, "thread")}`) +
      dim(` across ${plural(projects, "project")}`) +
      (mix ? dim(" — ") + mix : ""),
  ];

  // Focus = threads waiting on the owner, loudest-first. The sidebar carries the rest.
  const needsYou = active
    .filter((t) => t.state === "needs-you")
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.lastMessageAt.localeCompare(a.lastMessageAt));

  if (!needsYou.length) {
    out.push("", dim("  Nothing needs you right now — it's all in the sidebar →"));
    return out;
  }

  out.push("", dim("  Needs you now:"));
  for (const t of needsYou.slice(0, FOCUS_CAP)) {
    // Line 1 — • repo — next action, priority badge right-aligned. The repo is the project
    // reference; the action is the concrete thing to do.
    const badge = t.priority ? bold(prio(t.priority)(`P${t.priority}`)) : "";
    const action = (t.nextSteps || "open the thread").replace(/\s+/g, " ").trim();
    let lead = "  " + cyan("• ") + cyan(t.repo) + dim(" — ") + action;
    if (badge) {
      const room = W - visibleWidth(badge) - 1;
      if (visibleWidth(lead) > room) lead = truncateToWidth(lead, room);
      const gap = Math.max(1, W - visibleWidth(lead) - visibleWidth(badge));
      out.push(lead + " ".repeat(gap) + badge);
    } else {
      out.push(visibleWidth(lead) > W ? truncateToWidth(lead, W) : lead);
    }
    // Line 2 — the why (triage summary, else the topic), greyed under the action.
    const why = (t.summary || displayTopic(t)).replace(/\s+/g, " ").trim();
    if (why) out.push(dim("      " + truncateToWidth(why, W - 6)));
  }
  const more = needsYou.length - FOCUS_CAP;
  if (more > 0) out.push(dim(`  • +${more} more waiting → in the sidebar`));

  // Only point at the sidebar's remainder when there actually is one (working/idle threads).
  if (active.length > needsYou.length) out.push("", dim("  Everything else is in the sidebar →"));
  return out;
}

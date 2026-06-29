// Owner Operator — the extension that makes pi's STOCK interactive mode (interactive.ts) behave
// like ours, WITHOUT hand-rolling a shell. This is the proof of pi's extension seams:
//   · registerMessageRenderer — render present_threads triage as OUR cards inline in the chat log
//     (closes the gap where stock mode showed triage only as the tool call + its text result)
//   · registerCommand          — /done and /threads as REAL slash commands (autocomplete + arg
//     completions for free, the same core numbering the branded TUI uses)
// Everything here reuses what already exists: buildCardsBlock (cards.ts), the Backend seam
// (client.ts), and the core numbering/helpers — no duplicate logic, no second shell.

import { type Component } from "@earendil-works/pi-tui";
import {
  type ExtensionAPI,
  type ExtensionFactory,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { buildCardsBlock } from "./cards";
import { resolveBackend } from "./client";
import {
  numberThreads,
  toSidebarThreads,
  parseNumbers,
  displayTopic,
  type Thread,
  type SidebarThread,
  type StatusSnapshot,
} from "@owner-operator/core";

// Custom message types we render. The model/agent never sees these — they're display-only
// entries we append, rendered by the renderers registered below.
const CARDS = "owner-operator:cards";
const NOTICE = "owner-operator:notice";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

/** A trivial Component over a width→lines function — the shape pi's MessageRenderer returns. */
class RenderLines implements Component {
  constructor(private readonly produce: (width: number) => string[]) {}
  invalidate(): void { /* stateless */ }
  render(width: number): string[] { return this.produce(width); }
}

const cardsRenderer: MessageRenderer<{ threads: Thread[] }> = (message) =>
  new RenderLines((width) => buildCardsBlock(message.details?.threads ?? [], width));

const noticeRenderer: MessageRenderer<{ lines: string[] }> = (message) =>
  new RenderLines(() => (message.details?.lines ?? []).map(dim));

/** Current active threads numbered by the SAME core numbering the branded sidebar/`/done` use,
 *  read through the Backend seam (daemon or store). The number is the owner's handle. */
async function currentByNum(): Promise<Map<number, SidebarThread>> {
  const backend = await resolveBackend();
  const snap: StatusSnapshot = (await backend.loadSnapshot()) ?? { polledAt: "", threads: [] };
  const rows = toSidebarThreads(snap, await backend.loadTriage());
  return numberThreads(rows).byNum;
}

function sendCards(pi: ExtensionAPI, threads: Thread[]): void {
  pi.sendMessage(
    { customType: CARDS, content: `Triaged ${threads.length} thread(s).`, display: true, details: { threads } },
    { triggerTurn: false },
  );
}

export const ownerOperatorExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerMessageRenderer(CARDS, cardsRenderer);
  pi.registerMessageRenderer(NOTICE, noticeRenderer);

  // present_threads is a structured-output tool: instead of letting its triage land as a bare
  // tool-result line, render it as our cards right there in the stock log.
  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "present_threads") return;
    sendCards(pi, (event.args?.threads ?? []) as Thread[]);
  });

  // /done 1,3 — mark active threads done by their current number, with completions that list the
  // live numbers + topics as you type. Resolves through the Backend (single writer) like the TUI.
  pi.registerCommand("done", {
    description: "Mark active threads done by number, e.g. /done 1,3",
    getArgumentCompletions: async (prefix) => {
      const last = prefix.split(",").pop()?.trim() ?? "";
      const byNum = await currentByNum();
      return [...byNum.entries()]
        .map(([n, t]) => ({ value: String(n), label: `${n}`, description: displayTopic(t) }))
        .filter((i) => i.value.startsWith(last));
    },
    handler: async (args, ctx) => {
      const byNum = await currentByNum();
      const hits = parseNumbers(args).map((n) => byNum.get(n)).filter((t): t is SidebarThread => !!t);
      if (!hits.length) {
        ctx.ui.notify("usage: /done 1,3,5 — current thread numbers", "warning");
        return;
      }
      await (await resolveBackend()).markThreadsDone(hits.map((t) => t.id));
      ctx.ui.notify(`✓ done · ${hits.map((t) => `${t.num} ${displayTopic(t)}`).join(" · ")}`);
    },
  });

  // /threads — re-render the current triage as cards on demand (no model turn), reusing the same
  // renderer + Backend snapshot. Handy when the triage has scrolled out of view.
  pi.registerCommand("threads", {
    description: "Show the current active-thread triage as cards",
    handler: async () => {
      const byNum = await currentByNum();
      const threads = [...byNum.values()].map((t): Thread => ({
        id: t.id, topic: displayTopic(t), priority: t.priority ?? 1,
        summary: t.summary ?? "", nextSteps: t.nextSteps ?? "", repo: t.repo, app: t.app,
        created: "", lastActive: t.lastActive,
        diffAdded: t.diffAdded, diffDeleted: t.diffDeleted,
      }));
      sendCards(pi, threads);
    },
  });

  // /help — a dim cheat-sheet rendered into the log (pi's own / menu covers built-ins).
  pi.registerCommand("help", {
    description: "Owner Operator commands",
    handler: async () => {
      pi.sendMessage(
        {
          customType: NOTICE,
          content: "help",
          display: true,
          details: {
            lines: [
              "Owner Operator — interactive mode",
              "  /done 1,3    mark active threads done by number",
              "  /threads     re-show the current triage as cards",
              "  /help        this list",
              "  triage from present_threads renders as cards above",
              "  (pi built-ins: type / for the menu · ↑ history · ctrl+c exit)",
            ],
          },
        },
        { triggerTurn: false },
      );
    },
  });
};

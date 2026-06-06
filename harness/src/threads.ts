// Owner Operator — structured thread view. For each active CLI-agent session it shows
// what actually matters when triaging: the Topic, a Summary of what's gone on, and the
// Next steps — reasoned by the model over the thread's opening + most-recent messages
// (NOT a raw turn dump) — plus the facts (Repo, App, Created, Last active). Rendered as
// readable pi-tui cards.
//
//   tsx src/threads.ts                 # branded TUI cards (needs a TTY)
//   tsx src/threads.ts --since 7d      # any get-active-threads flag is forwarded
//   tsx src/threads.ts --plain         # plain structured text (no TUI; pipe-friendly)
//   tsx src/threads.ts --facts         # skip model synthesis (facts only, no Summary/Next)
//
// Read-only: gathers via the deterministic get-active-threads skill, synthesizes via the
// model, and never drives a session.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TUI, ProcessTerminal, Text, Box, Spacer, matchesKey } from "@earendil-works/pi-tui";
import { createOwnerOperatorSession, lastAssistantText } from "./agent";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const skill = join(repoRoot, ".agents", "skills", "get-active-threads", "get-active-threads.mjs");

// ---------- raw-ANSI stylers (same palette as tui.ts) ----------
type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), cyan = sgr(36), yellow = sgr(33), green = sgr(32), brand = sgr(1, 35);

// ---------- args ----------
const argv = process.argv.slice(2);
const plain = argv.includes("--plain");
const factsOnly = argv.includes("--facts");
const passthrough = argv.filter((a) => a !== "--plain" && a !== "--facts"); // forward --since / --sample / --all / …

// ---------- gather (deterministic skill → JSON) ----------
interface Turn { role: string; text: string; at: string | null }
interface Thread {
  id: string;
  repo: string;            // Repo Name
  ui: string;              // App the session was made from
  secondsSinceCreated: number;
  secondsSinceLastMessage: number;
  topic: string;
  link: string | null;
  firstMessages: Turn[];   // opening messages — the "what was this about" end
  recentMessages: Turn[];  // most-recent messages — the "where it stands now" end
}
// Model-synthesized triage, keyed by thread id.
interface Brief { summary: string; nextSteps: string }

function gather(): { since: string; threads: Thread[] } {
  const out = execFileSync(process.execPath, [skill, "--json", ...passthrough], { encoding: "utf8" });
  return JSON.parse(out);
}

// ---------- synthesis (model reasons over each thread's two ends) ----------
const turns = (ts: Turn[]) => ts.map((m) => `${m.role === "user" ? "you" : "agent"}: ${m.text}`).join("\n");

async function synthesize(threads: Thread[]): Promise<Map<string, Brief>> {
  const briefs = new Map<string, Brief>();
  if (threads.length === 0) return briefs;

  const payload = threads.map((t) => ({
    id: t.id,
    topic: t.topic,
    opening: turns(t.firstMessages),
    recent: turns(t.recentMessages),
  }));

  const request =
    "Triage these local agent threads. For EACH thread, reason over its `opening` and " +
    "`recent` messages and infer what has generally happened and what should happen next. " +
    "Do NOT quote a single turn; synthesize the arc of the conversation.\n" +
    "Return ONLY a JSON array (no prose, no code fences) of objects:\n" +
    `  {"id": <id>, "summary": <one sentence on what's gone on / current state>, ` +
    `"nextSteps": <one short clause on the concrete next action>}\n` +
    "Do NOT run any tools or skills — everything you need is below.\n\n" +
    JSON.stringify(payload, null, 2);

  const { session } = await createOwnerOperatorSession();
  try {
    await session.prompt(request);
    const text = lastAssistantText(session);
    const start = text.indexOf("["), end = text.lastIndexOf("]");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      for (const b of parsed) {
        if (b && b.id != null) briefs.set(String(b.id), { summary: String(b.summary ?? ""), nextSteps: String(b.nextSteps ?? "") });
      }
    }
  } finally {
    try { session.dispose(); } catch { /* ignore */ }
  }
  return briefs;
}

// ---------- formatting ----------
// All times are relative ("53 minutes ago", "2 hours ago", "2 days ago") — never a
// calendar date, which is noise when triaging what's fresh vs. stale.
function rel(s: number): string {
  if (s < 45) return "just now";
  const m = Math.round(s / 60); if (s < 3600) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(s / 3600); if (s < 86400) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(s / 86400); return `${d} day${d === 1 ? "" : "s"} ago`;
}

const LABEL_W = 13; // fits "Last active" / "Next steps" + padding
const field = (label: string, value: string) => `${dim(label.padEnd(LABEL_W))}${value}`;

// One card per thread: Topic on top, the synthesized Summary + Next steps, then the facts.
function cardLines(t: Thread, brief?: Brief): string[] {
  const lines = [bold(`● ${t.topic}`)];
  if (brief?.summary) lines.push(field("Summary", brief.summary));
  if (brief?.nextSteps) lines.push(field("Next steps", yellow(brief.nextSteps)));
  lines.push(
    field("Repo Name", green(t.repo)),
    field("App", cyan(t.ui)),
    field("Created", rel(t.secondsSinceCreated)),
    field("Last active", rel(t.secondsSinceLastMessage)),
  );
  if (t.link) lines.push(dim(`open: ${t.link}`));
  return lines;
}

// ---------- plain (no TUI) ----------
function renderPlain(data: { since: string; threads: Thread[] }, briefs: Map<string, Brief>): void {
  if (data.threads.length === 0) { console.log(`No active threads since ${data.since}.`); return; }
  console.log(brand("● Owner Operator") + dim(`  active threads since ${data.since} — ${data.threads.length}\n`));
  for (const t of data.threads) {
    for (const l of cardLines(t, briefs.get(t.id))) console.log("  " + l);
    console.log("");
  }
}

// ---------- TUI ----------
function renderTui(data: { since: string; threads: Thread[] }, briefs: Map<string, Brief>): void {
  const tui = new TUI(new ProcessTerminal());

  const header = new Box(1, 0);
  header.addChild(new Text(brand("● Owner Operator")));
  header.addChild(new Text(dim(`structured threads · since ${data.since} · ${data.threads.length} thread(s) · q / ctrl+c to exit`)));
  tui.addChild(header);

  if (data.threads.length === 0) {
    const empty = new Box(1, 0);
    empty.addChild(new Text(dim(`No active threads since ${data.since}.`)));
    tui.addChild(empty);
  } else {
    for (const t of data.threads) {
      const card = new Box(2, 0);
      for (const l of cardLines(t, briefs.get(t.id))) card.addChild(new Text(l));
      tui.addChild(card);
      tui.addChild(new Spacer(1));
    }
  }

  const quit = (): never => { tui.stop(); process.exit(0); };
  tui.addInputListener((d: string) => {
    if (matchesKey(d, "ctrl+c") || matchesKey(d, "q") || matchesKey(d, "escape")) quit();
    return undefined;
  });

  tui.start();
  tui.requestRender();
}

// ---------- main ----------
try {
  const data = gather();
  let briefs = new Map<string, Brief>();
  if (!factsOnly && data.threads.length) {
    process.stderr.write(dim("Synthesizing thread summaries…\n"));
    try {
      briefs = await synthesize(data.threads);
    } catch (e: any) {
      process.stderr.write(yellow(`⚠ summaries unavailable (${e?.message ?? e}); showing facts only.\n`));
    }
  }
  if (plain || !process.stdout.isTTY) renderPlain(data, briefs);
  else renderTui(data, briefs);
} catch (e: any) {
  console.error(yellow(`⚠ ${e?.message ?? e}`));
  process.exit(1);
}

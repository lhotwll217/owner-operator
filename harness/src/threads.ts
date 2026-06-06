// Owner Operator — structured thread view. Renders active CLI-agent sessions as readable,
// labeled cards (Repo Name · App · Day created · Last message sent) using pi-tui components.
//
//   tsx src/threads.ts                 # branded TUI cards (needs a TTY)
//   tsx src/threads.ts --since 7d      # any get-active-threads flag is forwarded
//   tsx src/threads.ts --plain         # plain structured text (no TUI; pipe-friendly)
//
// The data comes from the deterministic get-active-threads skill (--json); this file only
// shapes it for the eye. Keep it read-only: it never drives a session.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TUI, ProcessTerminal, Text, Box, Spacer, matchesKey } from "@earendil-works/pi-tui";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const skill = join(repoRoot, ".agents", "skills", "get-active-threads", "get-active-threads.mjs");

// ---------- raw-ANSI stylers (same palette as tui.ts) ----------
type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), cyan = sgr(36), blue = sgr(34), yellow = sgr(33), green = sgr(32), brand = sgr(1, 35);

// ---------- args ----------
const argv = process.argv.slice(2);
const plain = argv.includes("--plain");
const passthrough = argv.filter((a) => a !== "--plain"); // forward --since / --last / --all / …

// ---------- gather (deterministic skill → JSON) ----------
interface Turn { role: string; text: string; at: string | null }
interface Thread {
  id: string;
  repo: string;          // Repo Name
  ui: string;            // App the session was made from
  createdAt: string;     // Day created (ISO)
  lastMessageAt: string; // Last message sent (ISO)
  secondsSinceLastMessage: number;
  lastRole: string;
  messageCount: number;
  topic: string;
  link: string | null;
  bookends: { first: Turn[]; last: Turn[]; omitted: number };
}

function gather(): { since: string; threads: Thread[] } {
  const out = execFileSync(process.execPath, [skill, "--json", ...passthrough], { encoding: "utf8" });
  return JSON.parse(out);
}

// ---------- formatting ----------
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Day created" — day only, no clock noise (year only when it isn't this year).
function day(isoStr: string): string {
  const d = new Date(isoStr), now = new Date();
  const base = `${MON[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}
// "Last message" — relative only ("53 minutes ago", "2 hours ago", "1 day ago").
function rel(s: number): string {
  if (s < 45) return "just now";
  const m = Math.round(s / 60); if (s < 3600) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(s / 3600); if (s < 86400) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(s / 86400); return `${d} day${d === 1 ? "" : "s"} ago`;
}

const LABEL_W = 13; // "Last message" + padding
const field = (label: string, value: string) => `${dim(label.padEnd(LABEL_W))}${value}`;
const clip = (s: string, n = 200) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// The latest turn = the best deterministic read on current state / what's next.
function latest(t: Thread): Turn | null {
  const arr = t.bookends?.last?.length ? t.bookends.last : (t.bookends?.first ?? []);
  return arr.length ? arr[arr.length - 1] : null;
}
// Whose move it is now — the actionable "next step" signal.
function nextStep(t: Thread): string {
  return t.lastRole === "user"
    ? "agent's move — it's working / left mid-task"
    : "your move — reply to drive it forward";
}

// One card per thread. Leads with Topic + current State/Next (the signals that matter),
// then the structured fields. "Last message" is relative-only on purpose.
function cardLines(t: Thread): string[] {
  const cur = latest(t);
  const lines = [
    bold(`● ${t.topic}`),
    field("State", cur ? `${dim(cur.role === "user" ? "you›" : "asst›")} ${clip(cur.text)}` : dim("(no messages)")),
    field("Next", yellow(nextStep(t))),
    field("Repo Name", green(t.repo)),
    field("App", cyan(t.ui)),
    field("Day created", day(t.createdAt)),
    field("Last message", `${rel(t.secondsSinceLastMessage)} ${dim(`· ${t.lastRole === "user" ? "you spoke last" : "agent spoke last"}`)}`),
    dim(`${t.messageCount} msgs${t.link ? ` · open: ${t.link}` : ""}`),
  ];
  return lines;
}

// ---------- plain (no TUI) ----------
function renderPlain(data: { since: string; threads: Thread[] }): void {
  if (data.threads.length === 0) { console.log(`No active threads since ${data.since}.`); return; }
  console.log(brand("● Owner Operator") + dim(`  active threads since ${data.since} — ${data.threads.length}\n`));
  for (const t of data.threads) {
    for (const l of cardLines(t)) console.log("  " + l);
    console.log("");
  }
}

// ---------- TUI ----------
function renderTui(data: { since: string; threads: Thread[] }): void {
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
      for (const l of cardLines(t)) card.addChild(new Text(l));
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
  if (plain || !process.stdout.isTTY) renderPlain(data);
  else renderTui(data);
} catch (e: any) {
  console.error(yellow(`⚠ ${e?.message ?? e}`));
  process.exit(1);
}

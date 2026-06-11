// Owner Operator — branded terminal UI on pi-tui. A fixed-viewport layout (see screen.ts):
// a pinned left thread-rail beside the chat, with the editor at the bottom. The rail's CONTENT
// is the active-thread digest (via the model-free poll); its titles/summary/priority are the
// cached model triage (from present_threads) merged by id — the rail never calls the LLM.
// Agent core: agent.ts.

import {
  TUI,
  ProcessTerminal,
  Text,
  Box,
  Spacer,
  Markdown,
  Editor,
  Loader,
  matchesKey,
  type Component,
  type MarkdownTheme,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { createOwnerOperatorSession, lastAssistantText } from "./agent";
import { sortByPriority, toSidebarThreads, numberThreads, parseNumbers, displayTopic, becameNeedsYou, type Thread, type StatusSnapshot, type StatusDiff, type ThreadStatus, type TriageInfo, type SidebarThread } from "@owner-operator/core";
import { buildCard } from "./cards";
import { SidebarList } from "./sidebar";
import { Screen, Columns, ChatPane } from "./screen";
import { StatusPoller } from "./poller";
import { resolveBackend } from "./client";

if (!process.stdout.isTTY) {
  console.error('Owner Operator TUI needs an interactive terminal.\nUse `./harness/oo` in a real terminal, or `./harness/oo "question"` for a one-shot.');
  process.exit(1);
}

// theme: raw-ANSI styler maps (EditorTheme/MarkdownTheme are just (text) => string)
type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), italic = sgr(3), underline = sgr(4), strike = sgr(9);
const cyan = sgr(36), blue = sgr(34), yellow = sgr(33), green = sgr(32), red = sgr(1, 31), brand = sgr(1, 35);

const mdTheme: MarkdownTheme = {
  heading: (t) => bold(cyan(t)), link: blue, linkUrl: dim, code: yellow, codeBlock: green,
  codeBlockBorder: dim, quote: italic, quoteBorder: dim, hr: dim, listBullet: cyan,
  bold, italic, strikethrough: strike, underline,
};
const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: { selectedPrefix: blue, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim },
};

const SIDEBAR_W = 51;   // rail column CAP — the split is responsive: min(51, 40% of terminal)
const SPLIT_MIN = 80;   // below this the rail hides entirely; above, it shrinks before the chat does

const { session, skills, modelLabel } = await createOwnerOperatorSession();

// State backend: the daemon when it runs (spawned here if needed — it owns the poll loop
// and pushes snapshots), the store + an embedded poller otherwise. One writer when daemon-
// backed; the store's write-boundary hold keeps embedded mode safe too.
const backend = await resolveBackend({ spawnDaemon: true });

const tui = new TUI(new ProcessTerminal());

// ---- chat surface (unchanged components, just bounded by ChatPane in the layout) ----------
const header = new Box(0, 0);
header.addChild(new Text(brand("● Owner Operator")));
header.addChild(new Text(dim(`local chief of staff · ${modelLabel} · ${skills.length} skills · /done 1,3 · esc stop · ctrl+c exit`)));
header.addChild(new Spacer(1));

const log = new Box(0, 0);
const hint = new Text(dim('Ask what\'s ongoing — e.g. "what needs me today?"'));
log.addChild(hint);

const editor = new Editor(tui, editorTheme);

// ---- live thread rail + fixed-viewport layout --------------------------------------------
// A TRUE sidebar: the rail spans the full body height; the editor lives in the right column
// (it never runs under the rail). See screen.ts.
const sidebar = new SidebarList();
const columns = new Columns(sidebar, new ChatPane(log), editor, SIDEBAR_W, SPLIT_MIN);
const screen = new Screen(tui.terminal, header, columns);
tui.addChild(screen);
tui.setFocus(editor);

// The rail is LIVE: membership = the poll snapshot; the cached triage enriches it
// (title/priority/nextStep) by id. `/done` sets thread status to done, so rows leave the
// active rail until new activity wakes them.
let statusSnapshot: StatusSnapshot = (await backend.loadSnapshot()) ?? { polledAt: "", threads: [] };
const triageCache: Map<string, TriageInfo> = await backend.loadTriage();
let railByNum: Map<number, SidebarThread> = new Map(); // displayed number → thread, for /done
function refreshRail(): void {
  const rows = toSidebarThreads(statusSnapshot, triageCache);
  railByNum = numberThreads(rows).byNum; // same core numbering the rail renders — no drift
  sidebar.setThreads(rows);
  tui.requestRender();
}
// Triage (full or targeted) only ENRICHES by id — never decides membership (the poll does).
function cacheTriage(threads: Thread[]): void {
  let changed = false;
  for (const t of threads) {
    if (!t.id) continue;
    triageCache.set(t.id, { topic: t.topic, summary: t.summary, nextSteps: t.nextSteps, priority: t.priority });
    changed = true;
  }
  if (changed) { backend.saveTriage(triageCache).catch(() => { /* best-effort */ }); refreshRail(); }
}

let poller: StatusPoller | undefined;
let unsubscribePush: (() => void) | undefined;
let spin: NodeJS.Timeout | undefined;
function quit(): never {
  try { unsubscribePush?.(); } catch { /* ignore */ }
  try { backend.close(); } catch { /* ignore */ }
  try { poller?.stop(); } catch { /* ignore */ }
  try { if (spin) clearInterval(spin); } catch { /* ignore */ }
  try { session.dispose(); } catch { /* ignore */ }
  try { triage?.session.dispose(); } catch { /* ignore */ }
  tui.stop();
  process.exit(0);
}

// ---- focus: rail vs editor ----------------------------------------------------------------
// The rail is glance-only — never focused. The editor always has focus.
function focusEditor(): void { tui.setFocus(editor); tui.requestRender(); }

tui.addInputListener((data: string) => {
  if (matchesKey(data, "ctrl+c")) quit();
  // esc while a turn is running → stop it (abort the in-flight prompt; runTurn settles it).
  if (busy && matchesKey(data, "escape")) {
    stopRequested = true;
    void session.abort();
    return { consume: true };
  }
  return undefined; // the editor handles everything else
});

// ---- structured thread cards (from the present_threads tool call) -------------------------
// Card layout lives in cards.ts (previewable without a TTY). The same triage also enriches
// the rail: cache topic/summary/priority by id — NOT per poll, only when the model triages.
class Card implements Component {
  constructor(private readonly t: Thread) {}
  invalidate(): void { /* stateless */ }
  render(width: number): string[] { return buildCard(this.t, width); }
}

function renderThreadCards(threads: Thread[]): void {
  if (!threads.length) { log.addChild(new Text(dim("(no active threads)"))); tui.requestRender(); return; }
  for (const t of sortByPriority(threads)) {
    log.addChild(new Card(t));
    log.addChild(new Spacer(1));
  }
  tui.requestRender();
}

interface Turn { md: Markdown; acc: string; loader: Loader; loaderRemoved: boolean; mdAdded: boolean; cardsShown: boolean }
let current: Turn | null = null;
let busy = false;
let stopRequested = false; // esc pressed mid-turn → session.abort(), settle with "■ stopped"

function removeLoader(): void {
  if (current && !current.loaderRemoved) { log.removeChild(current.loader); current.loaderRemoved = true; }
}

session.subscribe((event: any) => {
  if (!current) return;

  // Model presented its triage → render the (frozen) chat cards AND enrich the live rail by id.
  if (event.type === "tool_execution_start" && event.toolName === "present_threads") {
    removeLoader();
    const threads = (event.args?.threads ?? []) as Thread[];
    renderThreadCards(threads);
    cacheTriage(threads);
    current.cardsShown = true;
    return;
  }

  if (event.type === "tool_execution_start" && event.toolName === "mark_thread_done") {
    // The tool writes through the backend during this turn. Reconcile on the next tick so
    // the rail reflects the write without waiting for the interval/push.
    setTimeout(() => { if (poller) void poller.poll(); else void backend.forcePoll(); }, 0).unref?.();
    return;
  }

  const ame = event.assistantMessageEvent;
  if (event.type === "message_update" && ame?.type === "text_delta") {
    current.acc += ame.delta;
    removeLoader();
    if (!current.mdAdded) { log.addChild(current.md); current.mdAdded = true; }
    current.md.setText(current.acc);
    tui.requestRender();
  }
});

// One agent turn: loader → streamed prose / present_threads cards → settle. Shared by user
// input and the startup brief.
async function runTurn(promptText: string, emptyMsg = "(no response)"): Promise<void> {
  const loader = new Loader(tui, cyan, dim, "working…");
  log.addChild(loader);
  current = { md: new Markdown("", 0, 0, mdTheme), acc: "", loader, loaderRemoved: false, mdAdded: false, cardsShown: false };
  tui.requestRender();
  try {
    await session.prompt(promptText);
    removeLoader();
    if (stopRequested) {
      log.addChild(new Text(dim("■ stopped")));
    } else if (current && !current.mdAdded && !current.cardsShown) {
      current.md.setText(lastAssistantText(session) || dim(emptyMsg));
      log.addChild(current.md);
    }
  } catch (e: any) {
    removeLoader();
    log.addChild(stopRequested ? new Text(dim("■ stopped")) : new Text(yellow(`⚠ ${e?.message ?? e}`)));
  } finally {
    stopRequested = false;
    current = null;
    busy = false;
    focusEditor();
    tui.requestRender();
  }
}

// /done 1,3 — mark rail rows `done` by their DISPLAYED number. Persists by thread id (the
// number is just the handle), the rows leave the rail on this render.
async function markDone(arg: string): Promise<void> {
  const hits = parseNumbers(arg).map((n) => railByNum.get(n)).filter((t): t is SidebarThread => !!t);
  if (!hits.length) {
    log.addChild(new Text(dim("usage: /done 1,3,5 — the rail row numbers")));
  } else {
    const result = await backend.markThreadsDone(hits.map((t) => t.id));
    if (result.snapshot) statusSnapshot = result.snapshot;
    log.addChild(new Text(green("✓ done") + dim(" › ") + hits.map((t) => `${t.num} ${displayTopic(t)}`).join(dim(" · "))));
  }
  refreshRail();
}

async function handleSubmit(text: string): Promise<void> {
  const q = text.trim();
  editor.setText("");
  if (!q) return;
  if (q === "/exit" || q === "/quit") return quit();
  if (q === "/done" || q.startsWith("/done ")) return markDone(q.slice(5));
  if (busy) return;
  busy = true;
  log.addChild(new Text(`${bold(blue("you"))} › ${q}`));
  await runTurn(q);
}

// First response on open: a fresh, full triage (cards) so the rail piggybacks off live data,
// never stale cache. Runs every launch by design — you wanted fresh, not cached.
async function startupBrief(): Promise<void> {
  if (busy) return;
  busy = true;
  log.removeChild(hint);
  log.addChild(new Text(dim("▸ bringing your threads up to date…")));
  await runTurn("What's ongoing today? Run get-active-threads and present every active thread as cards.", "(nothing active today)");
}

editor.onSubmit = (text: string) => {
  handleSubmit(text).catch((e: any) => { log.addChild(new Text(yellow(`⚠ ${e?.message ?? e}`))); tui.requestRender(); });
};

// ---- event-driven nextStep refresh -------------------------------------------------------
// The poll is cheap (status/recency, no model). Only when a thread ENTERS needs-you (a new
// assistant response → now waiting on you) do we run a SMALL targeted triage for THAT thread,
// on a SEPARATE session so it never blocks input or pollutes the chat log. Unchanged threads
// are never re-summarized.
let startupDone = false;                 // the startup full-triage covers the initial set
let triage: Awaited<ReturnType<typeof createOwnerOperatorSession>> | null = null;
const refreshing = new Set<string>();    // dedupe per thread
const queue: ThreadStatus[] = [];        // serialize bg refreshes (one session, sequential prompts)
let draining = false;

async function bgSession() {
  if (!triage) {
    triage = await createOwnerOperatorSession();
    // capture its present_threads → enrich the cache for that one thread (no chat rendering)
    triage.session.subscribe((event: any) => {
      if (event.type === "tool_execution_start" && event.toolName === "present_threads") {
        cacheTriage((event.args?.threads ?? []) as Thread[]);
      }
    });
  }
  return triage.session;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const t = queue.shift()!;
      try {
        const s = await bgSession();
        await s.prompt(`A new response just landed on thread ${t.id} — it's now waiting on the user. Refresh ONLY that thread: run get-active-threads --thread ${t.id} --sample 15, then call present_threads with that single thread (fresh topic + nextSteps).`);
      } catch { /* best-effort background refresh */ }
      refreshing.delete(t.id);
    }
  } finally { draining = false; }
}

function refreshNextStep(t: ThreadStatus): void {
  if (refreshing.has(t.id)) return;
  refreshing.add(t.id);
  queue.push(t);
  void drain();
}

function onPoll(snap: StatusSnapshot, diff: StatusDiff): void {
  statusSnapshot = snap;   // live membership for the rail (every active thread, no filter)
  refreshRail();
  if (!startupDone) return; // the startup full triage enriches the initial set
  // working→needs-you transitions (new assistant output) + brand-new needs-you threads not yet
  // triaged → targeted single-thread refresh enriches them. Never touch unchanged/idle.
  for (const t of becameNeedsYou(diff)) refreshNextStep(t);
  for (const t of diff.appeared) if (t.state === "needs-you" && !triageCache.has(t.id)) refreshNextStep(t);
}

// ---- start ----
refreshRail();                              // instant: last snapshot + triage cache, so it isn't blank
if (backend.subscribe) {
  // Daemon mode: the daemon owns the poll loop (interval + fs.watch); the rail rides its
  // push stream. Triage saved by ANY surface arrives here too — multi-surface consistency.
  unsubscribePush = backend.subscribe((e) => {
    if (e.type === "snapshot") onPoll(e.snapshot, e.diff);
    else if (e.type === "triage") {
      for (const [id, info] of Object.entries(e.entries)) triageCache.set(id, info);
      refreshRail();
    }
  });
} else {
  // Embedded mode (no daemon / OO_DAEMON=0): this process polls, exactly as before.
  poller = new StatusPoller({ since: "today", intervalMs: 15_000 });
  poller.subscribe(onPoll);
  poller.start();   // 15s interval — fallback/reconciliation
  poller.watch();   // fs.watch on the session dirs — the responsive path (debounced ~600ms)
}

// Animate the `working` spinner (~8 fps) only while something is actually working.
spin = setInterval(() => { if (sidebar.hasWorking()) { sidebar.tick(); tui.requestRender(); } }, 120);
spin.unref?.();

tui.start();
tui.requestRender();

// First response on open is a fresh full triage (cards); the rail piggybacks off it. Targeted
// per-thread refreshes only kick in afterwards, on needs-you transitions.
void startupBrief().then(() => { startupDone = true; });

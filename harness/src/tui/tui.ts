// Owner Operator — branded terminal UI on pi-tui (opt-in: `oo --tui`; the default surface
// is pi's stock interactive mode, interactive.ts). A fixed-viewport layout (see screen.ts):
// a pinned left thread-sidebar beside the chat, with the editor at the bottom. The sidebar's CONTENT
// is the active-thread digest (via the model-free poll); its titles/summary/priority are the
// cached model triage (from present_threads) merged by id — the sidebar never calls the LLM.
// Agent core: agent.ts.

import {
  TUI,
  ProcessTerminal,
  Text,
  Box,
  Spacer,
  Markdown,
  Editor,
  matchesKey,
  isKeyRelease,
  isKeyRepeat,
  type Component,
  type MarkdownTheme,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { createOwnerOperatorSession, lastAssistantText, shutdownSessionExtensions } from "../agent/agent";
import { toSidebarThreads, numberThreads, parseNumbers, displayTopic, becameNeedsYou, type Thread, type StatusSnapshot, type StatusDiff, type ThreadStatus, type TriageInfo, type SidebarThread } from "@owner-operator/core";
import { buildBrief } from "./brief";
import { SidebarList } from "./sidebar";
import { Screen, Columns, ChatPane } from "./screen";
import { Block, StatusLine, StatusFooter, PromptEditor, type FooterData } from "./chat";
import { readClipboardImage } from "./clipboard";
import { StatusPoller } from "@owner-operator/gateway/poller";
import { resolveBackend } from "@owner-operator/gateway/client";

if (!process.stdout.isTTY) {
  console.error('Owner Operator TUI needs an interactive terminal.\nUse `./harness/oo` in a real terminal, or `./harness/oo "question"` for a one-shot.');
  process.exit(1);
}

// theme: raw-ANSI styler maps (EditorTheme/MarkdownTheme are just (text) => string)
type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), italic = sgr(3), underline = sgr(4), strike = sgr(9);
const cyan = sgr(36), blue = sgr(34), yellow = sgr(33), green = sgr(32), white = sgr(1, 37);

const mdTheme: MarkdownTheme = {
  heading: (t) => bold(cyan(t)), link: blue, linkUrl: dim, code: yellow, codeBlock: green,
  codeBlockBorder: dim, quote: italic, quoteBorder: dim, hr: dim, listBullet: cyan,
  bold, italic, strikethrough: strike, underline,
};
const gray = sgr(90); // a clearly-visible border gray (stronger than dim)
const editorTheme: EditorTheme = {
  borderColor: gray,
  selectList: { selectedPrefix: blue, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim },
};

const SIDEBAR_W = 51;   // sidebar column CAP — the split is responsive: min(51, 40% of terminal)
const SPLIT_MIN = 80;   // below this the sidebar hides entirely; above, it shrinks before the chat does
const SIDEBAR_STEP = 3;    // sidebar lines per Shift+↑/↓ — about one thread block

const { session, skills, modelLabel } = await createOwnerOperatorSession("tui");

// State backend: the daemon when it runs (spawned here if needed — it owns the poll loop
// and pushes snapshots), the store + an embedded poller otherwise. One writer when daemon-
// backed; the store's write-boundary hold keeps embedded mode safe too.
const backend = await resolveBackend({ spawnDaemon: true });

const tui = new TUI(new ProcessTerminal());

// ---- chat surface (unchanged components, just bounded by ChatPane in the layout) ----------
// Big white wordmark — solid blocks, generated with figlet (not hand-drawn): "ANSI Compact"
// as the standard size, "ANSI Regular" on wide terminals. Width-aware: the largest rendering
// that fits wins (Screen never truncates header lines); narrower still → the one-liner.
const WORDMARK_LG = [
  " ██████  ██     ██ ███    ██ ███████ ██████          ██      ██████  ██████  ███████ ██████   █████  ████████  ██████  ██████",
  "██    ██ ██     ██ ████   ██ ██      ██   ██        ██      ██    ██ ██   ██ ██      ██   ██ ██   ██    ██    ██    ██ ██   ██",
  "██    ██ ██  █  ██ ██ ██  ██ █████   ██████        ██       ██    ██ ██████  █████   ██████  ███████    ██    ██    ██ ██████",
  "██    ██ ██ ███ ██ ██  ██ ██ ██      ██   ██      ██        ██    ██ ██      ██      ██   ██ ██   ██    ██    ██    ██ ██   ██",
  " ██████   ███ ███  ██   ████ ███████ ██   ██     ██          ██████  ██      ███████ ██   ██ ██   ██    ██     ██████  ██   ██",
];
const WORDMARK_MD = [
  "▄████▄ ██     ██ ███  ██ ██████ █████▄      █   ▄████▄ █████▄ ██████ █████▄  ▄████▄ ██████ ▄████▄ █████▄",
  "██  ██ ██ ▄█▄ ██ ██ ▀▄██ ██▄▄   ██▄▄██▄    █    ██  ██ ██▄▄█▀ ██▄▄   ██▄▄██▄ ██▄▄██   ██   ██  ██ ██▄▄██▄",
  "▀████▀  ▀██▀██▀  ██   ██ ██▄▄▄▄ ██   ██   █     ▀████▀ ██     ██▄▄▄▄ ██   ██ ██  ██   ██   ▀████▀ ██   ██",
];
const widest = (art: string[]): number => Math.max(...art.map((l) => l.length));
const LG_W = widest(WORDMARK_LG), MD_W = widest(WORDMARK_MD);
class Wordmark implements Component {
  invalidate(): void { /* stateless */ }
  render(width: number): string[] {
    const art = width >= LG_W ? WORDMARK_LG : width >= MD_W ? WORDMARK_MD : null;
    return art ? art.map(white) : [white("● OWNER / OPERATOR")];
  }
}

const header = new Box(0, 0);
header.addChild(new Wordmark());
header.addChild(new Text(dim(`local chief of staff · ${skills.length} skills · /done 1,3 · ⇧↑↓ Scroll Chat · ⌥↑↓ Scroll Sidebar · ⌃R Hide Sidebar · /help · ctrl+c exit`)));
header.addChild(new Spacer(1));

const log = new Box(0, 0);
const hint = new Text(dim('Ask what\'s ongoing — e.g. "what needs me today?"'));
log.addChild(hint);

// paddingX:2 leaves a 2-col inset on the input line; PromptEditor swaps the left inset for "› ".
const editor = new Editor(tui, editorTheme, { paddingX: 2 });
const promptEditor = new PromptEditor(editor, bold(blue(">")) + " ");

// ---- live thread sidebar + fixed-viewport layout --------------------------------------------
// A TRUE sidebar: the sidebar spans the full body height; the editor lives in the right column
// (it never runs under the sidebar). See screen.ts.
const sidebar = new SidebarList();
const chat = new ChatPane(log);
const columns = new Columns(sidebar, chat, promptEditor, SIDEBAR_W, SPLIT_MIN);

// Pinned status bar: pi's own SessionStats / context-usage drive it (no token math of our own).
// Refreshed on message/turn end (not every frame); the footer component just renders the snapshot.
let footerData: FooterData | null = null;
function computeFooter(): FooterData {
  const s = session as any;
  let cu: any, st: any;
  try { cu = s.getContextUsage?.(); } catch { /* not ready yet */ }
  try { st = s.getSessionStats?.(); } catch { /* not ready yet */ }
  return {
    model: modelLabel,
    contextTokens: cu?.tokens ?? null,
    contextWindow: cu?.contextWindow ?? s.model?.contextWindow ?? 0,
    percent: cu?.percent ?? null,
    inTok: st?.tokens?.input ?? 0,
    outTok: st?.tokens?.output ?? 0,
    cacheTok: st?.tokens?.cacheRead ?? 0,
  };
}
function refreshFooter(): void { footerData = computeFooter(); tui.requestRender(); }
footerData = computeFooter(); // show the model immediately; context fills in after the first turn
const footer = new StatusFooter(() => footerData);
const screen = new Screen(tui.terminal, header, columns, footer);
tui.addChild(screen);
tui.setFocus(editor);

// The sidebar is LIVE: membership = the poll snapshot; the cached triage enriches it
// (title/priority/nextStep) by id. `/done` sets thread status to done, so rows leave the
// active sidebar until new activity wakes them.
let statusSnapshot: StatusSnapshot = (await backend.loadSnapshot()) ?? { polledAt: "", threads: [] };
const triageCache: Map<string, TriageInfo> = await backend.loadTriage();
let sidebarByNum: Map<number, SidebarThread> = new Map(); // displayed number → thread, for /done
function refreshSidebar(): void {
  const rows = toSidebarThreads(statusSnapshot, triageCache);
  sidebarByNum = numberThreads(rows).byNum; // same core numbering the sidebar renders — no drift
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
  if (changed) { backend.saveTriage(triageCache).catch(() => { /* best-effort */ }); refreshSidebar(); }
}

let poller: StatusPoller | undefined;
let unsubscribePush: (() => void) | undefined;
let spin: NodeJS.Timeout | undefined;
async function quit(): Promise<never> {
  try { unsubscribePush?.(); } catch { /* ignore */ }
  try { backend.close(); } catch { /* ignore */ }
  try { poller?.stop(); } catch { /* ignore */ }
  try { if (spin) clearInterval(spin); } catch { /* ignore */ }
  await shutdownSessionExtensions(session); // cron auto-cleanup etc. (triage is unbound — skip)
  try { session.dispose(); } catch { /* ignore */ }
  try { triage?.session.dispose(); } catch { /* ignore */ }
  tui.stop();
  process.exit(0);
}

// ---- focus: sidebar vs editor ----------------------------------------------------------------
// The sidebar is glance-only — never focused. The editor always has focus.
function focusEditor(): void { tui.setFocus(editor); tui.requestRender(); }

// ---- pasted-image attachments ------------------------------------------------------------
// gpt-5.5 + pi take image input. Ctrl+V (pi's app.clipboard.pasteImage binding, read with pi's
// native clipboard reader) inserts an "[Image #N]" token INTO THE INPUT — the Claude Code / OpenCode
// pattern, not a line in the transcript. On submit, tokens still present in the text resolve to their
// images (handleSubmit); the model gets the text with the marker plus the image content.
type PendingImage = { type: "image"; data: string; mimeType: string };
const imageStore = new Map<number, PendingImage>(); // token number → image, until the message is sent
let imageSeq = 0;
let attaching = false;

async function attachClipboardImage(): Promise<void> {
  if (attaching) return;
  attaching = true;
  try {
    const img = await readClipboardImage();
    if (!img) return; // Ctrl+V with no image on the clipboard → no-op (text paste is the terminal's job)
    const n = ++imageSeq;
    imageStore.set(n, { type: "image", ...img });
    editor.insertTextAtCursor?.(`[Image #${n}] `); // shows in the input; resolves to the image on submit
    tui.requestRender();
  } finally { attaching = false; }
}

// ↑/↓ scroll the chat a line at a time; holding accelerates — the step doubles on each rapid
// same-direction press (auto-repeat), so a long scroll covers ground fast, and resets on a pause
// or a direction change. Date.now() is fine here (the real TUI runtime, not the workflow sandbox).
let scrollAccel = 1, scrollDir = 0, scrollAt = 0;
function chatLineScroll(dir: -1 | 1): void {
  const now = Date.now();
  scrollAccel = dir === scrollDir && now - scrollAt < 250 ? Math.min(scrollAccel * 2, 32) : 1;
  scrollDir = dir; scrollAt = now;
  chat.scroll(dir * scrollAccel);
  tui.requestRender();
}

tui.addInputListener((data: string) => {
  // Ignore key-RELEASE events: the Kitty keyboard protocol sends a press AND a release for one
  // keypress, so acting on both fired every action twice — Ctrl+R toggled straight back to where it
  // started, and the scroll keys double-stepped. Act on press/repeat only. (Paste is never a release.)
  if (isKeyRelease(data)) return undefined;
  if (matchesKey(data, "ctrl+c")) quit();
  // Ctrl+V → paste a copied image from the clipboard (pi's app.clipboard.pasteImage binding). The
  // control byte reaches the app directly, so it works regardless of how the terminal handles paste.
  if (matchesKey(data, "ctrl+v") && !isKeyRepeat(data)) { void attachClipboardImage(); return { consume: true }; }
  // esc while a turn is running → stop it (abort the in-flight prompt; runTurn settles it).
  if (busy && matchesKey(data, "escape")) {
    stopRequested = true;
    void session.abort();
    return { consume: true };
  }
  // Scroll the chat on Shift+↑/↓ — a modifier combo, so it never conflicts with typing, needs no
  // fn/PgUp, and works mid-turn. Holding accelerates. (Plain ↑/↓ stay with the editor; Cmd+arrows
  // aren't usable — macOS terminals don't forward them.) PgUp/PgDn page it too where those keys exist.
  if (matchesKey(data, "shift+up")) { chatLineScroll(-1); return { consume: true }; }
  if (matchesKey(data, "shift+down")) { chatLineScroll(1); return { consume: true }; }
  if (matchesKey(data, "pageUp")) { chat.scroll(-chat.pageStep()); tui.requestRender(); return { consume: true }; }
  if (matchesKey(data, "pageDown")) { chat.scroll(chat.pageStep()); tui.requestRender(); return { consume: true }; }
  // Scroll the Sidebar on Option+↑/↓ (overflow is rare; the ↑/↓ markers always show what's hidden).
  if (matchesKey(data, "alt+up")) { sidebar.scroll(-SIDEBAR_STEP); tui.requestRender(); return { consume: true }; }
  if (matchesKey(data, "alt+down")) { sidebar.scroll(SIDEBAR_STEP); tui.requestRender(); return { consume: true }; }
  // Hide the sidebar → chat fills the full width, so a normal terminal drag-select copies ONLY the
  // chat (no sidebar text, no separator bleeding in). Toggle back to bring the sidebar home. Press only
  // (ignore auto-repeat) so holding the key doesn't flicker the sidebar on/off.
  if (matchesKey(data, "ctrl+r") && !isKeyRepeat(data)) { columns.toggleSidebar(); tui.requestRender(); return { consume: true }; }
  return undefined; // the editor handles everything else
});

// ---- focused chat brief (from the present_threads tool call) ------------------------------
// The chat is the "what to do next" surface, not a second copy of the sidebar: the model triages
// EVERY active thread (which enriches the sidebar by id, below), but the chat shows only a short
// landscape summary + the few threads waiting on the owner. Brief layout lives in brief.ts
// (previewable without a TTY); it reads the SAME snapshot+triage the sidebar joins, so the two
// can't disagree. The rendered brief is frozen (a point-in-time chat message); the sidebar stays
// live.
class Brief implements Component {
  constructor(private readonly rows: readonly SidebarThread[]) {}
  invalidate(): void { /* stateless */ }
  render(width: number): string[] { return buildBrief(this.rows, width); }
}

function renderBrief(): void {
  log.addChild(new Brief(toSidebarThreads(statusSnapshot, triageCache)));
  log.addChild(new Spacer(1));
  tui.requestRender();
}

interface Turn { md: Markdown; acc: string; status: StatusLine | null; mdAdded: boolean; cardsShown: boolean }
let current: Turn | null = null;
let busy = false;
let stopRequested = false; // esc pressed mid-turn → session.abort(), settle with "■ stopped"

// ONE live-status line per turn, updated IN PLACE (working → thinking → running…) and removed when
// the answer or brief lands. The transient states never stack — and reasoning traces aren't shown
// (they're not visible/useful), so "thinking" is just a phase label on the same single line.
function setPhase(phase: string): void { if (current?.status) { current.status.setPhase(phase); tui.requestRender(); } }
function removeStatus(): void { if (current?.status) { log.removeChild(current.status); current.status = null; } }

// The assistant's prose gets a ● bullet + hanging indent (the Claude Code / gemini-cli sigil),
// added once on the first token (or the fallback). The brief path doesn't use it.
function ensureAssistantMd(): void {
  if (current && !current.mdAdded) {
    log.addChild(new Spacer(1));
    log.addChild(new Block(current.md, cyan("●") + " ", "  ", 2));
    current.mdAdded = true;
  }
}

// Tool name → the phase label shown on the single status line while that tool runs.
const TOOL_PHASE: Record<string, string> = {
  read: "reading", grep: "searching", find: "finding", ls: "listing",
  get_current_session_state: "checking the sidebar",
};

session.subscribe((event: any) => {
  if (!current) {
    if (event.type === "message_end" || event.type === "turn_end") refreshFooter();
    return;
  }

  // Model presented its triage → drop the status line, enrich the live sidebar by id, render the brief.
  if (event.type === "tool_execution_start" && event.toolName === "present_threads") {
    removeStatus();
    const threads = (event.args?.threads ?? []) as Thread[];
    cacheTriage(threads);
    renderBrief();
    current.cardsShown = true;
    return;
  }

  if (event.type === "tool_execution_start" && event.toolName === "mark_thread_done") {
    // The tool writes through the backend during this turn. Reconcile on the next tick so
    // the sidebar reflects the write without waiting for the interval/push.
    setTimeout(() => { if (poller) void poller.poll(); else void backend.forcePoll(); }, 0).unref?.();
    return;
  }

  // Any other tool (read/grep/find/scan/…) → just update the one status line's phase.
  if (event.type === "tool_execution_start") { setPhase(TOOL_PHASE[event.toolName] ?? event.toolName); return; }

  const ame = event.assistantMessageEvent;
  if (event.type === "message_update" && ame) {
    // Thinking is a phase on the single line — we don't render the (invisible) reasoning trace.
    if (ame.type === "thinking_start") { setPhase("thinking"); return; }
    if (ame.type === "thinking_end") { setPhase("working"); return; }
    // The answer: drop the status line, stream markdown under the ● bullet.
    if (ame.type === "text_delta") {
      current.acc += ame.delta;
      removeStatus();
      ensureAssistantMd();
      current.md.setText(current.acc);
      tui.requestRender();
      return;
    }
  }

  if (event.type === "message_end" || event.type === "turn_end") refreshFooter();
});

// One agent turn: a single status line → streamed prose / present_threads brief → settle. Shared
// by user input and the startup brief.
async function runTurn(promptText: string, emptyMsg = "(no response)", images?: PendingImage[]): Promise<void> {
  const status = new StatusLine("working");
  log.addChild(status);
  chat.toBottom(); // a new turn pulls you back to the latest, even if you'd scrolled into history
  current = { md: new Markdown("", 0, 0, mdTheme), acc: "", status, mdAdded: false, cardsShown: false };
  tui.requestRender();
  try {
    await session.prompt(promptText, images && images.length ? { images } : undefined);
    removeStatus();
    if (stopRequested) {
      log.addChild(new Text(dim("■ stopped")));
    } else if (current && !current.mdAdded && !current.cardsShown) {
      current.md.setText(lastAssistantText(session) || dim(emptyMsg));
      ensureAssistantMd();
    }
  } catch (e: any) {
    removeStatus();
    log.addChild(stopRequested ? new Text(dim("■ stopped")) : new Text(yellow(`⚠ ${e?.message ?? e}`)));
  } finally {
    stopRequested = false;
    current = null;
    busy = false;
    refreshFooter();
    focusEditor();
    tui.requestRender();
  }
}

// /done 1,3 — mark sidebar rows `done` by their DISPLAYED number. Persists by thread id (the
// number is just the handle), the rows leave the sidebar on this render.
async function markDone(arg: string): Promise<void> {
  const hits = parseNumbers(arg).map((n) => sidebarByNum.get(n)).filter((t): t is SidebarThread => !!t);
  if (!hits.length) {
    log.addChild(new Text(dim("usage: /done 1,3,5 — the sidebar row numbers")));
  } else {
    const result = await backend.markThreadsDone(hits.map((t) => t.id));
    if (result.snapshot) statusSnapshot = result.snapshot;
    log.addChild(new Text(green("✓ done") + dim(" › ") + hits.map((t) => `${t.num} ${displayTopic(t)}`).join(dim(" · "))));
  }
  refreshSidebar();
}

// /help (or /keys) — a dim cheat-sheet of the keymap, into the transcript (no overlay).
function showHelp(): void {
  const rows = [
    bold("Keys & commands"),
    dim("  Shift+↑ / ↓     scroll the chat  (hold to speed up · PgUp/PgDn pages it too)"),
    dim("  Alt+↑ / ↓       scroll the Sidebar"),
    dim("  Ctrl+R          hide the Sidebar — full-width chat for clean copy/paste"),
    dim("  Ctrl+V          paste a copied image from the clipboard"),
    dim("  /done 1,3       mark Sidebar rows done by number"),
    dim("  /help           this list"),
    dim("  esc  stop the running turn   ·   ctrl+c  exit"),
  ];
  const box = new Box(0, 0);
  for (const r of rows) box.addChild(new Text(r, 0, 0));
  log.addChild(new Spacer(1));
  log.addChild(box);
  chat.toBottom();
  tui.requestRender();
}

async function handleSubmit(text: string): Promise<void> {
  const q = text.trim();
  editor.setText("");
  if (q === "/exit" || q === "/quit") return quit();
  if (q === "/help" || q === "/keys") return showHelp();
  if (q === "/done" || q.startsWith("/done ")) return markDone(q.slice(5));
  // Resolve any [Image #N] tokens still in the text to their pasted images (deleted tokens drop out).
  const images: PendingImage[] = [];
  for (const m of q.matchAll(/\[Image #(\d+)\]/g)) {
    const img = imageStore.get(Number(m[1]));
    if (img) images.push(img);
  }
  if (!q && !images.length) return;   // nothing typed and no image referenced
  if (busy) return;                   // a turn is already running
  imageStore.clear(); imageSeq = 0;   // consumed into this turn
  busy = true;
  const bar = bold(blue("▌")) + " ";
  log.addChild(new Spacer(1));
  // The owner's own input, set off by a solid bright-blue left bar (the user-message convention).
  log.addChild(new Block(new Text(q || dim("(image)"), 0, 0), bar, bar, 2));
  await runTurn(q || "Here's an image.", "(no response)", images);
}

// First response on open: a fresh, full triage so the sidebar piggybacks off live data, never
// stale cache. The model triages EVERY active thread (that enriches the sidebar by id); the chat
// renders only the focused brief. Runs every launch by design — you wanted fresh, not cached.
async function startupBrief(): Promise<void> {
  if (busy) return;
  busy = true;
  log.removeChild(hint);
  log.addChild(new Text(dim("▸ bringing your threads up to date…")));
  await runTurn("What's ongoing today? Read get_current_session_state for the authoritative row set, call scan_active_transcripts for message samples, then triage with present_threads — every active row, merged with anything new the scan found, most-urgent first.", "(nothing active today)");
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
    // Internal enrichment worker, not an owner chat — ephemeral so it never lands in the
    // saved-sessions dir as a phantom "tui" thread.
    triage = await createOwnerOperatorSession("tui", { ephemeral: true });
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
        await s.prompt(`A new response just landed on thread ${t.id} — it's now waiting on the user. Refresh ONLY that thread: call scan_active_transcripts with thread=${t.id} and sample=15, then call present_threads with that single thread (fresh topic + nextSteps).`);
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
  statusSnapshot = snap;   // live membership for the sidebar (every active thread, no filter)
  refreshSidebar();
  if (!startupDone) return; // the startup full triage enriches the initial set
  // working→needs-you transitions (new assistant output) + brand-new needs-you threads not yet
  // triaged → targeted single-thread refresh enriches them. Never touch unchanged/idle.
  for (const t of becameNeedsYou(diff)) refreshNextStep(t);
  for (const t of diff.appeared) if (t.state === "needs-you" && !triageCache.has(t.id)) refreshNextStep(t);
}

// ---- start ----
refreshSidebar();                              // instant: last snapshot + triage cache, so it isn't blank
if (backend.subscribe) {
  // Daemon mode: the daemon owns the poll loop (interval + fs.watch); the sidebar rides its
  // push stream. Triage saved by ANY surface arrives here too — multi-surface consistency.
  unsubscribePush = backend.subscribe((e) => {
    if (e.type === "snapshot") onPoll(e.snapshot, e.diff);
    else if (e.type === "triage") {
      for (const [id, info] of Object.entries(e.entries)) triageCache.set(id, info);
      refreshSidebar();
    }
  });
} else {
  // Embedded mode (no daemon / OO_DAEMON=0): this process polls, exactly as before.
  poller = new StatusPoller({ intervalMs: 15_000 }); // window from owner settings (rolling "1d" default)
  poller.subscribe(onPoll);
  poller.start();   // 15s interval — fallback/reconciliation
  poller.watch();   // fs.watch on the session dirs — the responsive path (debounced ~600ms)
}

// Animate spinners (~8 fps): the sidebar's `working` rows and the current turn's single status line.
spin = setInterval(() => {
  let dirty = false;
  if (sidebar.hasWorking()) { sidebar.tick(); dirty = true; }
  if (current?.status) { current.status.tick(); dirty = true; }
  if (dirty) tui.requestRender();
}, 120);
spin.unref?.();

tui.start();
tui.requestRender();

// First response on open is a fresh full triage (cards); the sidebar piggybacks off it. Targeted
// per-thread refreshes only kick in afterwards, on needs-you transitions.
void startupBrief().then(() => { startupDone = true; });

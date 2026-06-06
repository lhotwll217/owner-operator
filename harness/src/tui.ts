// Owner Operator — branded terminal UI on pi-tui (the renderer pi/openclaw use).
// Header brand + streaming Markdown answers + a working-spinner + input. When the model
// triages threads it calls the `present_threads` tool (structured output); we render that
// payload as cards instead of prose. Agent core: agent.ts.

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
  visibleWidth,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { createOwnerOperatorSession, lastAssistantText, type PresentedThread } from "./agent";

if (!process.stdout.isTTY) {
  console.error('Owner Operator TUI needs an interactive terminal.\nUse `./harness/oo` in a real terminal, or `./harness/oo "question"` for a one-shot.');
  process.exit(1);
}

// theme: raw-ANSI styler maps (EditorTheme/MarkdownTheme are just (text) => string)
type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), italic = sgr(3), underline = sgr(4), strike = sgr(9);
const cyan = sgr(36), blue = sgr(34), yellow = sgr(33), green = sgr(32), red = sgr(1, 31), brand = sgr(1, 35);

// Priority badge: 5 is loudest, 1 fades out.
const prioBadge = (p: number): string => {
  const s = `P${p}`;
  return p >= 5 ? red(s) : p === 4 ? yellow(s) : p === 3 ? cyan(s) : dim(s);
};

const mdTheme: MarkdownTheme = {
  heading: (t) => bold(cyan(t)), link: blue, linkUrl: dim, code: yellow, codeBlock: green,
  codeBlockBorder: dim, quote: italic, quoteBorder: dim, hr: dim, listBullet: cyan,
  bold, italic, strikethrough: strike, underline,
};
const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: { selectedPrefix: blue, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim },
};

const { session, skills, modelLabel } = await createOwnerOperatorSession();

const tui = new TUI(new ProcessTerminal());

const header = new Box(1, 0);
header.addChild(new Text(brand("● Owner Operator")));
header.addChild(new Text(dim(`local chief of staff · ${modelLabel} · ${skills.length} skills · ctrl+c to exit`)));
tui.addChild(header);

const log = new Box(1, 0);
log.addChild(new Text(dim('Ask what\'s ongoing — e.g. "what needs me today?"')));
tui.addChild(log);

const editor = new Editor(tui, editorTheme);
tui.addChild(editor);
tui.setFocus(editor);

function quit(): never {
  try { session.dispose(); } catch { /* ignore */ }
  tui.stop();
  process.exit(0);
}
tui.addInputListener((data: string) => {
  if (matchesKey(data, "ctrl+c")) quit();
  return undefined; // don't consume other keys — let the editor handle them
});

// ---- structured thread cards (rendered from the present_threads tool call) ----
// A real bordered card, drawn to the current viewport width. Long values wrap inside the
// border; everything stays aligned by measuring *visible* width (ANSI-aware).
const LABEL_W = 12;        // "Last active" / "Next steps"
const MAX_W = 96;          // don't stretch cards across an ultra-wide terminal
const B = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

const padTo = (s: string, w: number): string => {
  const vis = visibleWidth(s);
  return vis >= w ? s : s + " ".repeat(w - vis);
};

function buildCard(t: PresentedThread, width: number): string[] {
  const W = Math.max(40, Math.min(width, MAX_W));
  const inner = W - 4;                       // "│ " + content + " │"
  const out: string[] = [];

  // top border carries the priority + topic as a title
  let title = `${prioBadge(t.priority)} ${bold(t.topic)}`;
  if (visibleWidth(title) > W - 5) title = truncateToWidth(title, W - 5);
  const fill = Math.max(0, W - 3 - visibleWidth(title));
  out.push(dim(B.tl + B.h) + " " + title + " " + dim(B.h.repeat(Math.max(0, fill - 1)) + B.tr));

  const row = (s: string) => out.push(dim(B.v) + " " + padTo(s, inner) + " " + dim(B.v));
  const field = (label: string, value: string) => {
    const lab = dim(label.padEnd(LABEL_W));
    const segs = wrapTextWithAnsi(value, inner - LABEL_W);
    (segs.length ? segs : [""]).forEach((seg, i) => row((i ? " ".repeat(LABEL_W) : lab) + seg));
  };

  field("Summary", t.summary);
  field("Next steps", yellow(t.nextSteps));
  field("Repo", green(t.repo));
  field("App", cyan(t.app));
  field("Updated", `${t.lastActive}  ${dim("· created " + t.created)}`);
  if (t.link) field("Open", dim(t.link));

  out.push(dim(B.bl + B.h.repeat(W - 2) + B.br));
  return out;
}

class Card implements Component {
  constructor(private readonly t: PresentedThread) {}
  invalidate(): void { /* stateless */ }
  render(width: number): string[] { return buildCard(this.t, width); }
}

function renderThreadCards(threads: PresentedThread[]): void {
  if (!threads.length) { log.addChild(new Text(dim("(no active threads)"))); tui.requestRender(); return; }
  const sorted = [...threads].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // highest priority first
  for (const t of sorted) {
    log.addChild(new Card(t));
    log.addChild(new Spacer(1));
  }
  tui.requestRender();
}

interface Turn { md: Markdown; acc: string; loader: Loader; loaderRemoved: boolean; mdAdded: boolean; cardsShown: boolean }
let current: Turn | null = null;
let busy = false;

function removeLoader(): void {
  if (current && !current.loaderRemoved) { log.removeChild(current.loader); current.loaderRemoved = true; }
}

session.subscribe((event: any) => {
  if (!current) return;

  // Model presented its triage as structured output → render cards, not prose.
  if (event.type === "tool_execution_start" && event.toolName === "present_threads") {
    removeLoader();
    renderThreadCards(event.args?.threads ?? []);
    current.cardsShown = true;
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

async function handleSubmit(text: string): Promise<void> {
  const q = text.trim();
  editor.setText("");
  if (!q) return;
  if (q === "/exit" || q === "/quit") return quit();
  if (busy) return;
  busy = true;

  log.addChild(new Text(`${bold(blue("you"))} › ${q}`));
  const loader = new Loader(tui, cyan, dim, "working…");
  log.addChild(loader);
  current = { md: new Markdown("", 0, 0, mdTheme), acc: "", loader, loaderRemoved: false, mdAdded: false, cardsShown: false };
  tui.requestRender();

  try {
    await session.prompt(q);
    // No streamed prose and no cards: fall back to the final assistant text.
    if (current && !current.mdAdded && !current.cardsShown) {
      removeLoader();
      current.md.setText(lastAssistantText(session) || dim("(no response)"));
      log.addChild(current.md);
    } else {
      removeLoader();
    }
  } catch (e: any) {
    removeLoader();
    log.addChild(new Text(yellow(`⚠ ${e?.message ?? e}`)));
  } finally {
    current = null;
    busy = false;
    tui.setFocus(editor);
    tui.requestRender();
  }
}
editor.onSubmit = (text: string) => {
  handleSubmit(text).catch((e: any) => { log.addChild(new Text(yellow(`⚠ ${e?.message ?? e}`))); tui.requestRender(); });
};

tui.start();
tui.requestRender();

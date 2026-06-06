// Owner Operator — branded terminal UI on pi-tui (the renderer pi/openclaw use).
// Header brand + streaming Markdown answers + a working-spinner + input. Agent core: agent.ts.

import {
  TUI,
  ProcessTerminal,
  Text,
  Box,
  Markdown,
  Editor,
  Loader,
  matchesKey,
  type MarkdownTheme,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { createOwnerOperatorSession, lastAssistantText } from "./agent";

if (!process.stdout.isTTY) {
  console.error('Owner Operator TUI needs an interactive terminal.\nUse `./harness/oo` in a real terminal, or `./harness/oo "question"` for a one-shot.');
  process.exit(1);
}

// theme: raw-ANSI styler maps (EditorTheme/MarkdownTheme are just (text) => string)
type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), italic = sgr(3), underline = sgr(4), strike = sgr(9);
const cyan = sgr(36), blue = sgr(34), yellow = sgr(33), green = sgr(32), brand = sgr(1, 35);

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

interface Turn { md: Markdown; acc: string; loader: Loader; added: boolean }
let current: Turn | null = null;
let busy = false;

session.subscribe((event: any) => {
  const ame = event.assistantMessageEvent;
  if (current && event.type === "message_update" && ame?.type === "text_delta") {
    current.acc += ame.delta;
    if (!current.added) { log.removeChild(current.loader); log.addChild(current.md); current.added = true; }
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
  current = { md: new Markdown("", 0, 0, mdTheme), acc: "", loader, added: false };
  tui.requestRender();

  try {
    await session.prompt(q);
    if (current && !current.added) {
      log.removeChild(loader);
      current.md.setText(lastAssistantText(session) || dim("(no response)"));
      log.addChild(current.md);
    }
  } catch (e: any) {
    if (current && !current.added) log.removeChild(loader);
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

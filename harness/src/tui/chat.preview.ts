// Deterministic test of the chat transcript chrome — no model, no TTY.
//   npm run preview:chat   (from harness/)
// Covers the three render-layer pieces that give the log role separation:
//   · Block        — left-gutter prefixing (user-input bar, assistant bullet)
//   · Reasoning    — greyed thinking that collapses to "✦ thought for Ns"
//   · StatusFooter — the pinned context/token/model bar (from pi SessionStats)

import assert from "node:assert";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Block, StatusLine, StatusFooter, PromptEditor, type FooterData } from "./chat";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const stub = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });

// --- Block: a styled gutter on every line; the child is rendered narrower to make room ---
const b = new Block(stub(["one", "two", "three"]), "● ", "  ", 2);
const bl = b.render(20).map(stripAnsi);
assert.equal(bl[0], "● one", "first line carries the sigil");
assert.equal(bl[1], "  two", "continuation lines align under it (hanging indent)");
let gotWidth = 0;
new Block({ render: (w) => { gotWidth = w; return ["x"]; }, invalidate() {} }, "▌ ", "▌ ", 2).render(30);
assert.equal(gotWidth, 28, "child is rendered gutter-width narrower so the row still fits");
assert.deepEqual(new Block(stub(["a"]), "", "", 0).render(10), ["a"], "no gutter width → passthrough");

// --- PromptEditor: swaps the editor's leading pad for a "> " prompt on the first content line ---
const fakeEditor: Component = { render: () => ["────────", "  hello world", "  more", "────────"], invalidate() {} };
const pe = new PromptEditor(fakeEditor, "> ").render(20).map(stripAnsi);
assert.deepEqual(pe, ["────────", "> hello world", "  more", "────────"], "prompt on the first content line; rules + continuation untouched");

// --- StatusLine: ONE animated line for the live turn state, phase updates in place (no stacking) ---
const sl = new StatusLine();
assert.equal(sl.render(80).length, 1, "always a single line");
assert.match(stripAnsi(sl.render(80)[0]), /working…/, "default phase is working");
sl.setPhase("thinking");
assert.match(stripAnsi(sl.render(80)[0]), /thinking…/, "phase updates in place (same line, not a new one)");
sl.setPhase("reading");
assert.match(stripAnsi(sl.render(80)[0]), /^⠋? ?reading…|reading…/, "phase swaps again");
const before = sl.render(80)[0]; sl.tick(); const after = sl.render(80)[0];
assert.notEqual(before, after, "tick advances the spinner glyph");
process.stdout.write(stripAnsi(sl.render(80)[0]) + "\n\n");

// --- StatusFooter: context gauge · token spend · model, from a snapshot callback ---
assert.deepEqual(new StatusFooter(() => null).render(80), [], "no data → no footer line (nothing pinned yet)");
const data: FooterData = { model: "openai-codex/gpt-5.5", contextTokens: 86000, contextWindow: 200000, percent: 43, inTok: 453600, outTok: 9400, cacheTok: 4000000 };
const foot = new StatusFooter(() => data).render(120);
process.stdout.write(stripAnsi(foot[0]) + "\n\n");
assert.equal(foot.length, 1, "one status line");
const ft = stripAnsi(foot[0]);
assert.match(ft, /ctx \[.+\] 86k\/200k 43%/, "context gauge: used/window + percent");
assert.match(ft, /↑454k ↓9k/, "token spend (in/out, compacted)");
assert.match(ft, /⚡4M/, "cache tokens when present");
assert.match(ft, /openai-codex\/gpt-5\.5$/, "model at the end");
assert.match(ft, /^ {2,}ctx /, "status is pinned to the right edge (left-padded)");

// percent colored by how full the window is (warn ≥50, error ≥90) — gemini-cli's convention
assert.ok(/\x1b\[33m43%/.test(new StatusFooter(() => ({ ...data, percent: 43 })).render(120)[0]) === false, "43% is not warn-colored");
assert.ok(/\x1b\[33m70%/.test(new StatusFooter(() => ({ ...data, percent: 70 })).render(120)[0]), "70% → yellow warn");
assert.ok(/\x1b\[1;31m95%/.test(new StatusFooter(() => ({ ...data, percent: 95 })).render(120)[0]), "95% → red");

// unknown context (right after compaction) and width clamp
assert.match(stripAnsi(new StatusFooter(() => ({ ...data, percent: null, contextTokens: null })).render(120)[0]), /ctx —/, "null percent → 'ctx —'");
assert.ok(visibleWidth(new StatusFooter(() => data).render(24)[0]) <= 24, "truncates to the terminal width");

process.stdout.write("ok — chat transcript chrome preview passed\n");

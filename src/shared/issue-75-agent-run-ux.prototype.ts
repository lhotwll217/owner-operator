// THROWAWAY PROTOTYPE — three terminal presentations for issue #75; never production code.
import readline from "node:readline";

const variants = ["A", "B", "C"] as const;
const states = ["active", "settled", "delegated", "completed", "picker", "attention"] as const;
type Variant = (typeof variants)[number];
type State = (typeof states)[number];

const requestedVariant = process.argv.find((arg) => arg.startsWith("--variant="))?.split("=")[1]?.toUpperCase();
const requestedState = process.argv.find((arg) => arg.startsWith("--state="))?.split("=")[1]?.toLowerCase();
let variantIndex = requestedVariant ? Math.max(0, variants.indexOf(requestedVariant as Variant)) : variants.indexOf("C");
let stateIndex = Math.max(0, states.indexOf(requestedState as State));

const dim = (value: string) => `\x1b[2m${value}\x1b[22m`;
const bold = (value: string) => `\x1b[1m${value}\x1b[22m`;
const green = (value: string) => `\x1b[32m${value}\x1b[39m`;
const yellow = (value: string) => `\x1b[33m${value}\x1b[39m`;
const red = (value: string) => `\x1b[31m${value}\x1b[39m`;

const prompt = `${bold("> Fix the delegated runner and research the UX patterns")}\n`;
const actions = [
  "Inspecting the delegated-run launcher",
  "Comparing Codex adapter versions",
  "Reviewing Codex and Pi activity patterns",
  "Updating the live acceptance test",
  "Running typecheck and lint",
  "Running the full test suite",
];
const answer = [
  "Pinned the working Codex ACP adapter and added a real startup acceptance test.",
  "The UX research recommends a parent-scoped run projection and Pi custom-message completion handoff.",
].join("\n");

function footer(state: State): string {
  if (state === "delegated" || state === "active") return `\n${dim("────────────────────────────────────────────────────────────")}\n${bold("Agent state:")} ${dim("◦ 1 queued")} · ${green("● 2 running")}       ${dim("/agent-state")}`;
  if (state === "completed") return `\n${dim("────────────────────────────────────────────────────────────")}\n${bold("Agent state:")} ${green("✓ research completed")}          ${dim("/agent-state")}`;
  if (state === "attention") return `\n${dim("────────────────────────────────────────────────────────────")}\n${bold("Agent state:")} ${yellow("! 1 needs attention")}           ${dim("/agent-state")}`;
  return "";
}

function lifecycle(state: State): string {
  if (state === "completed") {
    return `${green("✓")} ${bold("Research agent completed")} ${dim("· 14m")}\n\n` +
      "The research recommends adapting Turn Fold’s behavior without adopting its internal patches.\n" +
      "No owner decision is required.";
  }
  if (state === "attention") {
    return `${red("!")} ${bold("Codex agent failed during startup")} ${dim("· 3s")}\n\n` +
      "The child never established an ACP session. The run is available in /runs for inspection.";
  }
  return "";
}

function picker(): string {
  return [
    bold("Agent state"),
    "",
    `${green("●")} running    claude-code  Research Codex TUI patterns       4m 12s`,
    `${dim("◦")} queued     codex        Review Pi extensions              18s`,
    `${green("✓")} completed  codex        Fix Codex ACP startup             3m 41s`,
    `${red("!")} failed     claude-code  Review OpenClaw supervision       3s`,
    "",
    dim("↑/↓ select   enter inspect   c cancel   r resume   esc close"),
    "",
    dim("Detail ───────────────────────────────────────────────────"),
    "State:    running",
    "Task:     Research Codex TUI patterns",
    "Activity: Reading agent_status_feed.rs",
    "Started:  4m 12s ago",
  ].join("\n");
}

function variantA(state: State): string {
  if (state === "picker") return picker();
  if (state === "completed" || state === "attention") return prompt + "\n" + lifecycle(state) + footer(state);
  if (state === "settled") return prompt + `\n${dim("▶ Worked for 8m · 6 actions")}\n\n${answer}`;
  const activity = actions.map((action) => dim(action)).join("\n");
  return prompt + `\n${activity}\n\n${state === "delegated" ? dim("Waiting for the final local checks") : answer}` + footer(state);
}

function variantB(state: State): string {
  if (state === "picker") return picker();
  if (state === "completed" || state === "attention") return prompt + "\n" + lifecycle(state) + footer(state);
  if (state === "settled") {
    return prompt + `\n${dim("┌ Activity · Worked for 8m · 6 actions  [expand]")}\n${dim("└────────────────────────────────────────────")}\n\n${answer}`;
  }
  const activity = actions.map((action, index) => `${dim(index === actions.length - 1 ? "└" : "├")} ${action}`).join("\n");
  return prompt + `\n${dim("┌ Activity · running")}\n${activity}\n\n${state === "delegated" ? dim("Waiting for the final local checks") : answer}` + footer(state);
}

function variantC(state: State): string {
  if (state === "picker") return picker();
  if (state === "completed" || state === "attention") return prompt + "\n" + lifecycle(state) + footer(state);
  if (state === "settled") return prompt + `\n${dim("▶ 8m · 6 actions · expand trace")}\n\n${answer}`;
  const activity = actions.map((action, index) => index === actions.length - 1 ? `${green("●")} ${action}` : dim(`│ ${action}`)).join("\n");
  return prompt + `\n${activity}\n\n${state === "delegated" ? dim("Waiting for the final local checks") : answer}` + footer(state);
}

const names: Record<Variant, string> = {
  A: "Native transcript",
  B: "Anchored activity block",
  C: "Timeline rail",
};

function render(): void {
  const variant = variants[variantIndex];
  const state = states[stateIndex];
  const body = variant === "A" ? variantA(state) : variant === "B" ? variantB(state) : variantC(state);
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`${body}\n\n`);
  process.stdout.write(dim(`←/→ variant   ↑/↓ state   q quit\n${variant} — ${names[variant]}   state: ${state}\n`));
}

render();
if (!process.stdin.isTTY || process.argv.includes("--once")) process.exit(0);

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("keypress", (_text, key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0);
  if (key.name === "right") variantIndex = (variantIndex + 1) % variants.length;
  if (key.name === "left") variantIndex = (variantIndex - 1 + variants.length) % variants.length;
  if (key.name === "down") stateIndex = (stateIndex + 1) % states.length;
  if (key.name === "up") stateIndex = (stateIndex - 1 + states.length) % states.length;
  render();
});

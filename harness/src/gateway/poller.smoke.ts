// Integration smoke — runs the REAL "today" digest (no model), derives state, and renders the
// sidebar: the live poll snapshot enriched by any cached triage. Proves the non-UI
// path end to end. (In the live TUI the triage cache is populated by the model; here it's
// whatever's persisted, so untriaged threads show their raw digest topic.)
//   npx tsx src/poller.smoke.ts        (from harness/)

import { toSidebarThreads } from "@owner-operator/core";
import { StatusPoller } from "./poller";
import { SidebarList } from "../tui/sidebar";
import { loadSnapshot, loadTriage, STATUS_FILE } from "./store";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const poller = new StatusPoller({ since: "today", limit: 40 });
const snap = await poller.poll();
if (!snap) { console.error("poll returned null — scan failed"); process.exit(1); }

const sidebar = toSidebarThreads(snap, loadTriage());
console.log(`polled ${snap.threads.length} thread(s) today · sidebar projection ${sidebar.length} @ ${snap.polledAt}\n`);

const panel = new SidebarList(40);
panel.setThreads(sidebar);
for (const line of panel.render(34)) console.log("  " + (process.stdout.isTTY ? line : stripAnsi(line)));

const persisted = loadSnapshot();
console.log(`\nstore: ${STATUS_FILE}`);
console.log(`persisted ${persisted?.threads.length ?? 0} thread(s) — round-trip ${persisted?.polledAt === snap.polledAt ? "OK" : "MISMATCH"}`);

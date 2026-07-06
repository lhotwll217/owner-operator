// Integration smoke — runs the REAL "today" digest (no model), derives state, and prints the
// gateway's sidebar projection enriched by cached triage. Proves the non-UI path end to end.
//   npm run poll:smoke        (from packages/gateway/)

import { displayTopic, numberThreads, toSidebarThreads } from "@owner-operator/core";
import { StatusPoller } from "./poller";
import { loadSnapshot, loadTriage, STATUS_FILE } from "./store";

const poller = new StatusPoller({ since: "today", limit: 40 });
const snap = await poller.poll();
if (!snap) { console.error("poll returned null — scan failed"); process.exit(1); }

const sidebar = toSidebarThreads(snap, loadTriage());
console.log(`polled ${snap.threads.length} thread(s) today · sidebar projection ${sidebar.length} @ ${snap.polledAt}\n`);

for (const [n, t] of numberThreads(sidebar).byNum) {
  const pri = t.priority ? ` p${t.priority}` : "";
  console.log(`${String(n).padStart(2, " ")}. ${t.state}${pri} · ${t.repo} · ${displayTopic(t)}`);
}

const persisted = loadSnapshot();
console.log(`\nstore: ${STATUS_FILE}`);
console.log(`persisted ${persisted?.threads.length ?? 0} thread(s) — round-trip ${persisted?.polledAt === snap.polledAt ? "OK" : "MISMATCH"}`);

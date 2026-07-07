// Integration smoke — runs the REAL "today" digest (no model), persists state, and prints the
// gateway's DB-owned session-state projection. Proves the non-UI path end to end.
//   npm run poll:smoke        (from the repo root)

import { StatusPoller } from "./poller";
import { loadSessionState, loadSnapshot, STATUS_FILE } from "./store";

const poller = new StatusPoller({ since: "today", limit: 40 });
const snap = await poller.poll();
if (!snap) { console.error("poll returned null — scan failed"); process.exit(1); }

const rows = loadSessionState();
console.log(`polled ${snap.threads.length} thread(s) today · session-state rows ${rows.length} @ ${snap.polledAt}\n`);

for (const [i, t] of rows.entries()) {
  const pri = t.priority ? ` p${t.priority}` : "";
  console.log(`${String(i + 1).padStart(2, " ")}. ${t.state}${pri} · ${t.repo} · ${t.topic}`);
}

const persisted = loadSnapshot();
console.log(`\nstore: ${STATUS_FILE}`);
console.log(`persisted ${persisted?.threads.length ?? 0} thread(s) — round-trip ${persisted?.polledAt === snap.polledAt ? "OK" : "MISMATCH"}`);

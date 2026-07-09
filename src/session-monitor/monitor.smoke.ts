import { SessionMonitor } from "./monitor";
import { State } from "../state/state";

const state = new State();
const monitor = new SessionMonitor(state, { since: "today", limit: 40 });
const rows = await monitor.poll();
for (const [index, thread] of rows.entries()) {
  const priority = thread.priority ? ` p${thread.priority}` : "";
  console.log(`${String(index + 1).padStart(2, " ")}. ${thread.state}${priority} · ${thread.repo} · ${thread.topic}`);
}
monitor.stop();
state.close();

// A daemon stand-in for crash tests: runs the real scheduler and command runner over the State at argv[2].
import { State } from "../../state/state";
import { Scheduler } from "../scheduler";

new Scheduler(new State(process.argv[2]!), { tickMs: 60_000 }).start();
setInterval(() => undefined, 60_000);

// Run by install-runtime.sh from the installed runtime: replace whichever daemon serves, even a
// detached one from a checkout, and fail unless this runtime's daemon is the one serving.
import { ensureDaemon } from "../src/daemon/ensure";

await ensureDaemon({ takeOver: true });

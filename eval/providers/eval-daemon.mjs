// One managed daemon for an eval process. It is deliberately model-free: fixture state is
// ground truth, so enrichment would both mutate answers and add untracked spend.
import { startDaemon } from "../../src/daemon/runtime.ts";

const daemon = await startDaemon({
  port: 0,
  watch: false,
  enableEnrichment: false,
  monitor: { intervalMs: 60 * 60 * 1_000 },
  scheduler: { tickMs: 60 * 60 * 1_000 },
});

process.stdout.write(`[oo-eval-daemon] ready ${daemon.port}\n`);

await new Promise((resolve) => {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void daemon.close().then(resolve, (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
      resolve();
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
});

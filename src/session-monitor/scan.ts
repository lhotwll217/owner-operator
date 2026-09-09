import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ScanActiveTranscriptsResult } from "./scan-active-transcripts.mjs";

const execFileAsync = promisify(execFile);
const scanScript = fileURLToPath(new URL("./scan-active-transcripts.mjs", import.meta.url));

/** Run the synchronous transcript engine outside the daemon event loop. */
export async function runTranscriptScan(args: readonly string[]): Promise<ScanActiveTranscriptsResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [scanScript, ...args, "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as ScanActiveTranscriptsResult;
}

/** Bounded transcript context passed across the monitor → model-completion seam. */
export async function sampleTranscript(threadId: string, source: string): Promise<string> {
  if (["claude", "codex", "pi"].includes(source)) {
    const searchScript = fileURLToPath(new URL("../agent/skills/session-search/scripts/session-search.mjs", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [
      searchScript, "--skim", threadId, "--include-tools", "--max-chars", "24000",
    ], { encoding: "utf8", maxBuffer: 128 * 1024 });
    if (!stdout.startsWith(`skim id=${threadId} `)) throw new Error(`missing authorized evidence for ${threadId}`);
    return stdout;
  }
  const sample = await runTranscriptScan([
    "--thread", threadId, "--sample", "8", "--truncate", "2000", "--since", "30d",
  ]);
  if (sample.threads.length !== 1) throw new Error(`expected one authorized transcript for ${threadId}`);
  return JSON.stringify(sample, null, 2);
}

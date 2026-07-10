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
export async function sampleTranscript(threadId: string): Promise<string> {
  const sample = await runTranscriptScan([
    "--thread", threadId, "--sample", "8", "--since", "30d",
  ]);
  return JSON.stringify(sample, null, 2);
}

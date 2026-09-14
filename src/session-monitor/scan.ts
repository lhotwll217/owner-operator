import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ScanActiveTranscriptsResult } from "./scan-active-transcripts.mjs";
import type { EnrichmentCandidate } from "@owner-operator/core";

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
export async function sampleTranscript(threadId: string, source: string, maxChars = 24_000): Promise<string> {
  if (["claude", "codex", "pi"].includes(source)) {
    const searchScript = fileURLToPath(new URL("../session-search/session-search.mjs", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [
      searchScript, "--skim", threadId, "--include-tools", "--max-chars", String(maxChars),
    ], { encoding: "utf8", maxBuffer: 128 * 1024 });
    if (!stdout.startsWith(`skim id=${threadId} `)) throw new Error(`missing authorized evidence for ${threadId}`);
    return stdout.slice(0, maxChars);
  }
  const sample = await runTranscriptScan([
    "--thread", threadId, "--sample", "8", "--truncate", String(Math.floor(maxChars / 20)), "--since", "1970-01-01",
  ]);
  if (sample.threads.length !== 1 || sample.threads[0].id !== threadId) throw new Error(`expected one authorized transcript for ${threadId}`);
  return JSON.stringify(sample).slice(0, maxChars);
}

export async function sampleEnrichment(candidate: EnrichmentCandidate): Promise<string> {
  const samples = [await sampleTranscript(candidate.id, candidate.source)];
  let remaining = 24_000;
  for (const [index, child] of candidate.children.entries()) {
    if (remaining < 1_000) {
      samples.push(`${candidate.children.length - index} child transcripts omitted by the context limit.`);
      break;
    }
    const sample = `Delegated child ${child.id}, run ${child.runId}, status ${child.status}\n${await sampleTranscript(child.id, child.source, Math.min(8_000, remaining - 300))}`;
    samples.push(sample);
    remaining -= sample.length;
  }
  return samples.join("\n\n");
}

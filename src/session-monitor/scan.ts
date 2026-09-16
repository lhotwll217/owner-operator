import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ScanActiveTranscriptsResult } from "./scan-active-transcripts.mjs";
import { AgentRunStatus, type EnrichmentCandidate } from "@owner-operator/core";

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
    const { stdout } = await skim(threadId, maxChars);
    return stdout.slice(0, maxChars);
  }
  const sample = await runTranscriptScan([
    "--thread", threadId, "--sample", "8", "--truncate", String(Math.floor(maxChars / 20)), "--since", "1970-01-01",
  ]);
  if (sample.threads.length !== 1 || sample.threads[0].id !== threadId) throw new Error(`expected one authorized transcript for ${threadId}`);
  return JSON.stringify(sample).slice(0, maxChars);
}

/**
 * One privacy-aware read of a session, and the position it reached. The helper reports the
 * message count of the view it returned; the last index of that view is the position a status
 * summary written from it can be returned to with `--session <id> --at <index> --include-tools`.
 */
async function skim(threadId: string, maxChars: number): Promise<{ stdout: string; position: number | null }> {
  const searchScript = fileURLToPath(new URL("../session-search/session-search.mjs", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [
    searchScript, "--skim", threadId, "--include-tools", "--max-chars", String(maxChars),
  ], { encoding: "utf8", maxBuffer: 128 * 1024 });
  if (!stdout.startsWith(`skim id=${threadId} `)) throw new Error(`missing authorized evidence for ${threadId}`);
  const messages = Number(/\smessages=(\d+)\s/.exec(stdout)?.[1]);
  return { stdout, position: Number.isInteger(messages) && messages > 0 ? messages - 1 : null };
}

export interface EnrichmentSample {
  sample: string;
  /** Where this evidence ends, for the revision it produces. Absent when the source has no
   * addressable position. */
  bookmark?: { index: number; messageAt: string };
}

export async function sampleEnrichment(candidate: EnrichmentCandidate): Promise<EnrichmentSample> {
  const bookmark = await (async () => {
    if (!["claude", "codex", "pi"].includes(candidate.source) || !candidate.lastMessageAt) return undefined;
    const { position } = await skim(candidate.id, 500);
    return position === null ? undefined : { index: position, messageAt: candidate.lastMessageAt };
  })();
  const samples = [await sampleTranscript(candidate.id, candidate.source)];
  if (!candidate.children.length) return { sample: samples[0], ...(bookmark ? { bookmark } : {}) };
  const active = candidate.children.filter((child) => child.status === AgentRunStatus.Pending || child.status === AgentRunStatus.Running);
  const terminal = candidate.children.filter((child) => child.status !== AgentRunStatus.Pending && child.status !== AgentRunStatus.Running);
  const header = (child: EnrichmentCandidate["children"][number]) => `\n\nDelegated child ${child.id}, run ${child.runId}, status ${child.status}\n`;
  const coverage = "\n\nChild transcript excerpts are bounded, not complete verification of the children's work.";
  let remaining = 24_000 - coverage.length - 200;
  const activeHeaders = active.reduce((sum, child) => sum + header(child).length, 0);
  const activeBudget = Math.min(8_000, Math.floor((remaining - activeHeaders) / Math.max(1, active.length)));
  if (activeBudget < 1_000) throw new Error("active child evidence exceeds the bounded context; parent summary remains eligible");
  for (const child of active) {
    const sample = header(child) + await sampleTranscript(child.id, child.source, activeBudget);
    samples.push(sample);
    remaining -= sample.length;
  }
  let includedTerminal = 0;
  for (const child of terminal) {
    const budget = Math.min(8_000, remaining - header(child).length);
    if (budget < 1_000) break;
    const sample = header(child) + await sampleTranscript(child.id, child.source, budget);
    samples.push(sample);
    remaining -= sample.length;
    includedTerminal++;
  }
  samples.push(coverage);
  if (includedTerminal < terminal.length) samples.push(`\n${terminal.length - includedTerminal} terminal child transcripts omitted by the context limit; their work is not assessed here.`);
  return { sample: samples.join(""), ...(bookmark ? { bookmark } : {}) };
}

// Measure the title's life on real transcripts: how fast a distinguishing title replaces the
// opening prompt, and whether it then holds still while the same work continues.
//
//   node --import tsx eval/replay/title-lifecycle-probe.ts --capture <dir> --out <dir>
//     --threads <n>        how many of the slice's longest conversations to probe (default 6)
//     --prefix <fraction>  share of each conversation visible in the early pass (default 0.25)
//
// Each thread is probed twice against the SAME transcript. The early pass truncates the
// sandbox copy to its first messages — the moment the work had just started — and the late
// pass restores the whole conversation. Both passes run the production sampler and the
// production enrichment call, so the titles and the delays are the ones the daemon produces.
//
// The probe reports; it does not judge. Whether a changed title was a categorical change is a
// question for the transcript, and the recorded early/late pair is what that reading needs.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { closeSandboxUser, materializeSandboxUser } from "../sandbox-user.ts";
import { evalSandboxPath } from "../sandbox.mjs";
import { buildReplayHome } from "./build-replay-home.mjs";
import { startDaemon } from "../../src/daemon/runtime.ts";
import { sampleEnrichment } from "../../src/session-monitor/scan.ts";
import { enrichThread } from "../../src/agent/enrichment.ts";

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
const TIMESTAMP_FIELD = new RegExp(`("timestamp"\\s*:\\s*")(${ISO.source})(")`, "g");

function lastTimestamp(lines: readonly string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = TIMESTAMP_FIELD.exec(lines[index]);
    TIMESTAMP_FIELD.lastIndex = 0;
    if (match) return Date.parse(match[2]);
  }
  return null;
}

/** Rewrite one conversation so its final message lands on `targetMs`, keeping every gap. */
function shiftTo(lines: readonly string[], targetMs: number): string[] {
  const last = lastTimestamp(lines);
  if (last === null) return [...lines];
  const delta = targetMs - last;
  return lines.map((line) => line.replace(TIMESTAMP_FIELD, (_match, open, value, close) =>
    `${open}${new Date(Date.parse(value) + delta).toISOString()}${close}`));
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const capture = resolve(flag("capture", "") || (() => { throw new Error("--capture is required"); })());
const outRoot = resolve(flag("out", "") || (() => { throw new Error("--out is required"); })());
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const label = flag("label", `titles-${head}`);
const threadLimit = Number(flag("threads", "6"));
const prefixFraction = Number(flag("prefix", "0.25"));

const out = join(outRoot, label);
mkdirSync(out, { recursive: true });

const runId = `titles-${label.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
const root = evalSandboxPath(runId);
const liveOoHome = join(homedir(), ".owner-operator");

const sandbox = materializeSandboxUser({
  profile: "cli-driving",
  root,
  sourcePiAgentDir: join(liveOoHome, "pi"),
  protectedOwnerPaths: [liveOoHome, capture, outRoot, join(homedir(), ".claude"), join(homedir(), ".codex")],
});
const previousEnvironment = { ...process.env };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, sandbox.env);

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let failure: unknown;
const probes: Array<Record<string, unknown>> = [];
try {
  buildReplayHome({ capture, root, activeWindow: flag("active-window", "36h") });
  daemon = await startDaemon({
    port: 0,
    watch: false,
    enableEnrichment: false,
    monitor: { intervalMs: 60 * 60 * 1_000, logger: () => undefined },
    scheduler: { tickMs: 60 * 60 * 1_000 },
    agentRuns: {
      maxConcurrent: 0,
      tickMs: 60 * 60 * 1_000,
      launcher: Object.assign(
        async () => { throw new Error("the title probe cannot launch a delegated child"); },
        { reapOrphans: async () => undefined },
      ),
    },
  });

  // Truncate BEFORE the first poll: a thread is observed as it was early, then grows, which is
  // the sequence the watermark and the widget actually see. Transcript paths come from the
  // replay home's own roots; the owner's live files are never opened here.
  //
  // Each pass lands its own last message on the current clock — the early prefix arrives as
  // work that just started, and the restored conversation arrives as that work continuing —
  // so the owner's visibility window stays the production one instead of being widened here.
  // The threads the owner is actually looking at are the recent ones, and the capture records
  // which transcript each of them came from. Match by file name so the probe reads only the
  // sandbox's copy of that transcript.
  const captureDb = new DatabaseSync(join(capture, "state.db"), { readOnly: true });
  const recent = (captureDb.prepare(
    `SELECT t.transcript_path AS path FROM threads t
      WHERE t.transcript_path IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_runs run WHERE run.child_session_id = t.id)
      ORDER BY t.last_message_at DESC LIMIT ?`,
  ).all(threadLimit * 3) as unknown as Array<{ path: string }>).map((row) => basename(row.path));
  captureDb.close();

  const byName = new Map([join(sandbox.ooHome, "sessions"), join(root, "transcripts")]
    .flatMap((base) => walkJsonl(base))
    .map((path) => [basename(path), path] as const));
  const sandboxTranscripts = recent
    .flatMap((name) => (byName.has(name) ? [byName.get(name)!] : []))
    .map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n").filter(Boolean) }))
    .filter(({ lines }) => lines.length >= 8 && lastTimestamp(lines) !== null)
    .slice(0, threadLimit);

  const wholeOf = new Map<string, string>();
  for (const { path, lines } of sandboxTranscripts) {
    const whole = join(out, `${basename(path)}.whole`);
    copyFileSync(path, whole);
    wholeOf.set(path, whole);
    const prefix = earlyPrefix(lines, prefixFraction);
    writeFileSync(path, `${shiftTo(prefix, Date.now() - 60_000).join("\n")}\n`);
    const stamp = new Date();
    utimesSync(path, stamp, stamp);
  }

  await daemon.monitor.poll();
  const sandboxDb = new DatabaseSync(join(sandbox.ooHome, "state.db"), { readOnly: true });
  // Match on the file name: macOS resolves the sandbox's temporary root through /private, so
  // the observed path and the path this probe wrote are the same file under two spellings.
  const idOf = new Map(
    (sandboxDb.prepare("SELECT id, transcript_path AS path FROM threads WHERE transcript_path IS NOT NULL")
      .all() as unknown as Array<{ id: string; path: string }>)
      .map((row) => [basename(row.path), row.id] as const),
  );
  sandboxDb.close();
  for (const { path, lines } of sandboxTranscripts) {
    const id = idOf.get(basename(path));
    const row = id ? daemon.state.listCurrentSessionState().find((item) => item.id === id) : undefined;
    const whole = wholeOf.get(path)!;
    const probe: Record<string, unknown> = {
      id: id ?? null, source: row?.source, repo: row?.repo, app: row?.app,
      lines: lines.length, earlyLines: earlyPrefix(lines, prefixFraction).length,
      openingPromptTitle: row?.topic,
    };
    try {
      if (!row) throw new Error("the truncated transcript produced no visible row");
      // ---- early: the work has just started ------------------------------------------
      const early = daemon.state.listEnrichmentCandidates().find((candidate) => candidate.id === row.id);
      if (!early) throw new Error("the truncated thread left the visible set");
      probe.earlyPromptShown = early.topic;
      const earlyStart = Date.now();
      const earlySample = await sampleEnrichment(early);
      probe.earlySampleMs = Date.now() - earlyStart;
      const earlyDetails = await enrichThread(earlySample, { currentTitle: early.generatedTopic });
      probe.earlyTitleMs = Date.now() - earlyStart;
      probe.earlyTitle = earlyDetails.topic;
      probe.earlySummary = earlyDetails.statusSummary;
      daemon.state.appendEnrichment(row.id, earlyDetails, early.lastMessageAt!, early.children);

      // ---- late: the same work, the whole conversation ---------------------------------
      writeFileSync(path, `${shiftTo(readFileSync(whole, "utf8").split("\n").filter(Boolean), Date.now()).join("\n")}\n`);
      const now = new Date();
      utimesSync(path, now, now);
      await daemon.monitor.poll();
      const late = daemon.state.listEnrichmentCandidates().find((candidate) => candidate.id === row.id);
      if (!late) throw new Error("the restored thread left the enrichment set");
      probe.titleShownWhilePending = late.topic;
      probe.recapShownWhilePending = late.statusSummary;
      const lateStart = Date.now();
      const lateSample = await sampleEnrichment(late);
      probe.lateSampleMs = Date.now() - lateStart;
      const lateDetails = await enrichThread(lateSample, { currentTitle: late.generatedTopic });
      probe.lateTitleMs = Date.now() - lateStart;
      probe.lateTitle = lateDetails.topic;
      probe.lateSummary = lateDetails.statusSummary;
      daemon.state.appendEnrichment(row.id, lateDetails, late.lastMessageAt!, late.children);
      probe.titleHeld = lateDetails.topic === earlyDetails.topic;
      probe.finalTitle = daemon.state.listSessionState().find((item) => item.id === row.id)?.topic;
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
      copyFileSync(whole, path);
    }
    probes.push(probe);
    process.stderr.write(`${probes.length}/${sandboxTranscripts.length} ${id ?? basename(path)} ${probe.error ? `FAILED ${probe.error}` : `held=${probe.titleHeld}`}\n`);
  }

  const measured = probes.filter((probe) => !probe.error);
  writeFileSync(join(out, "titles.json"), `${JSON.stringify({
    probed: probes.length,
    measured: measured.length,
    heldThroughProgress: measured.filter((probe) => probe.titleHeld).length,
    earlyTitleMs: measured.map((probe) => probe.earlyTitleMs),
    lateTitleMs: measured.map((probe) => probe.lateTitleMs),
    probes,
  }, null, 2)}\n`);
} catch (error) {
  failure = error;
  writeFileSync(join(out, "failure.json"), `${JSON.stringify({ error: String(error) }, null, 2)}\n`);
} finally {
  const closed = await closeSandboxUser(sandbox, daemon?.port, async () => { await daemon?.close(); }, { kind: "titles", label });
  writeFileSync(join(out, "teardown.json"), `${JSON.stringify(closed, null, 2)}\n`);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
  if (!closed.teardownVerified) process.exitCode = 2;
  if (failure) process.exitCode = 1;
  else process.stderr.write(`title probe artifacts: ${out}\n`);
}

if (failure) throw failure;

/** The conversation as it stood early on: its opening turns, and everything they need to parse. */
function earlyPrefix(lines: readonly string[], fraction: number): string[] {
  const conversational = lines.flatMap((line, index) => {
    let parsed: { type?: string; payload?: { type?: string }; message?: unknown };
    try { parsed = JSON.parse(line); } catch { return []; }
    const kind = parsed.payload?.type ?? parsed.type;
    return parsed.message || kind === "message" || kind === "user" || kind === "assistant" ? [index] : [];
  });
  if (!conversational.length) return [...lines];
  const wanted = Math.min(conversational.length, Math.max(4, Math.floor(conversational.length * fraction)));
  return lines.slice(0, conversational[wanted - 1] + 1);
}

function walkJsonl(base: string): string[] {
  let entries: string[];
  try { entries = readdirSync(base, { recursive: true }) as string[]; } catch { return []; }
  return entries
    .map((entry) => join(base, String(entry)))
    .filter((path) => path.endsWith(".jsonl") && statSync(path).isFile());
}

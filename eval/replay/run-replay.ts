// Replay a captured slice of real session state through the production pipeline.
//
//   node --import tsx eval/replay/run-replay.ts --capture <dir> --out <dir> [options]
//     --label <name>          artifact subdirectory name (default: the current git HEAD)
//     --threads <n>           enrich only the n loudest candidates (fast iteration)
//     --no-enrich             observe and persist only; skip model enrichment
//     --sample-only           run the transcript sampler but no model call (free iteration)
//     --daemon-enrich         let the daemon's own enrichment queue run, and watch the rows
//     --restore-runs          put the capture's own pending/running delegated runs back after
//                             daemon startup recovery marks them interrupted
//     --active-child <runId>  additionally reconstruct one captured run as still running
//     --successive <n>        replay each selected transcript at n growing positions, so the
//                             pipeline writes real history instead of one final assessment
//     --successive-threads <id,…>  which sessions grow (default: the visible rows with turns)
//     --ask <file>            JSON [{id, question}] the production `oo` answers afterwards
//     --native <binary>       LiveSummaryProof build; renders these rows in the real widget
//     --active-window <w>     owner visibility window (default 36h, the owner's setting)
//
// `--daemon-enrich` is the mode that compares two code versions. It calls nothing this file
// owns: the daemon installs its own enrichment composition and drains its own serial queue,
// so each checkout of this harness measures that checkout's pipeline. The explicit loop below
// is a diagnostic for one version at a time.
//
// What runs is production code: the sandbox-user primitive owns isolation, `startDaemon`
// owns the daemon, `scanTranscripts` owns observation, and enrichment is the exact
// composition runtime.ts installs (`sampleEnrichment` then `enrichThread`). This file only
// sequences those calls and records what they produced.
//
// Isolation comes from the eval sandbox user: its own HOME, OO_HOME, state database, copied
// transcript roots, ephemeral loopback daemon, and verified teardown. The owner's live state
// is read during capture and never during replay.

import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSandboxUser, materializeSandboxUser } from "../sandbox-user.ts";
import { evalSandboxPath } from "../sandbox.mjs";
import { buildReplayHome } from "./build-replay-home.mjs";
import { prefixAt, shiftTo } from "./transcript-positions.mjs";
import { startDaemon } from "../../src/daemon/runtime.ts";
import { sampleEnrichment } from "../../src/session-monitor/scan.ts";
import { enrichThread } from "../../src/agent/enrichment.ts";
import type { SessionMonitorLogRecord } from "../../src/session-monitor/monitor.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const capture = resolve(flag("capture", "") || (() => { throw new Error("--capture is required"); })());
const outRoot = resolve(flag("out", "") || (() => { throw new Error("--out is required"); })());
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const label = flag("label", head);
const threadLimit = Number(flag("threads", "0"));
const activeWindow = flag("active-window", "36h");

const out = join(outRoot, label);
mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown): void => {
  writeFileSync(join(out, name), `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
};

const runId = `replay-${label.replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now()}`;
const root = evalSandboxPath(runId);
const liveOoHome = join(homedir(), ".owner-operator");

// The evaluated agent must not be able to read the capture, the expected answers, or the
// owner's live stores; the sandbox blacklist is what denies them.
// Both arms answer on the same model at the same reasoning level, pinned here rather than
// inherited, so a settings change between runs cannot masquerade as a code difference.
const MODEL = { defaultProvider: "openai-codex", defaultModel: "gpt-6-astra", defaultThinkingLevel: "high" as const };
const armRoot = resolve(join(import.meta.dirname, "..", ".."));
const otherCheckouts = [join(homedir(), "Development", "owner-operator"), "/opt/homebrew/lib/node_modules"];

const sandbox = materializeSandboxUser({
  profile: "cli-driving",
  root,
  sourcePiAgentDir: join(liveOoHome, "pi"),
  modelSettings: MODEL,
  // Name the owner's stores and this evaluation's own material, not the whole Owner Operator
  // home: a checkout under that home is where an arm's skills and search helper live, and an
  // arm that cannot read its own helper cannot answer from a transcript at all.
  // Blacklisting the other product checkouts is equally wrong — it would purge every replayed
  // thread whose work happened inside one. The trace records foreign-helper calls instead.
  protectedOwnerPaths: [
    capture, outRoot, join(liveOoHome, "workspace"),
    join(liveOoHome, "sessions"), join(liveOoHome, "pi"), join(liveOoHome, "state.db"),
    join(homedir(), ".claude"), join(homedir(), ".codex"),
  ],
});
const previousEnvironment = { ...process.env };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, sandbox.env);

const monitorLog: SessionMonitorLogRecord[] = [];
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let askDaemon: ReturnType<typeof spawn> | undefined;
let askPort = 0;
let failure: unknown;
try {
  const replay = buildReplayHome({ capture, root, activeWindow });
  write("replay.json", replay);

  // Which code answered. An arm is only comparable if its product code, its agent skills, and
  // its search helper all resolve inside the same checkout as this file.
  const coreEntry = fileURLToPath(await import.meta.resolve("@owner-operator/core"));
  write("provenance.json", {
    armRoot,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: armRoot, encoding: "utf8" }).trim(),
    uncommitted: execFileSync("git", ["status", "--porcelain"], { cwd: armRoot, encoding: "utf8" })
      .trim().split("\n").filter(Boolean),
    ooBinary: join(armRoot, "src", "cli", "oo.ts"),
    searchHelper: join(armRoot, "src", "agent", "skills", "session-search", "scripts", "session-search.mjs"),
    core: coreEntry,
    coreInsideArm: coreEntry.startsWith(armRoot + "/"),
    model: MODEL,
    capture,
    activeWindow,
    node: process.version,
  });

  daemon = await startDaemon({
    port: 0,
    watch: false,
    // Enrichment is driven explicitly below so each call's latency and failure is recorded.
    enableEnrichment: has("daemon-enrich"),
    monitor: { intervalMs: 60 * 60 * 1_000, logger: (record) => { monitorLog.push(record); } },
    scheduler: { tickMs: 60 * 60 * 1_000 },
    agentRuns: {
      maxConcurrent: 0,
      tickMs: 60 * 60 * 1_000,
      launcher: Object.assign(
        async () => { throw new Error("replay cannot launch a delegated child"); },
        { reapOrphans: async () => undefined },
      ),
    },
  });

  // ---- delegated runs the capture recorded as live ------------------------------------
  // A restarted daemon cannot own the children of the daemon before it, so startup marks every
  // running run interrupted. That recovery is correct in production and wrong for a replay: the
  // capture recorded a parent whose child was running, and that parent's working signal is part
  // of the evidence. Restoring the captured status separates the two, and each restored run is
  // named in the artifact so a reader can tell a captured state from a reconstructed one.
  const restoreRuns = has("restore-runs") || Boolean(flag("active-child", ""));
  if (restoreRuns) {
    const captured = new DatabaseSync(join(capture, "state.db"), { readOnly: true });
    const live = (captured.prepare(
      "SELECT id, status, parent_thread_id AS parent, child_session_id AS child FROM agent_runs WHERE status IN ('pending', 'running')",
    ).all() as unknown as Array<{ id: string; status: string; parent: string | null; child: string | null }>);
    const reconstructId = flag("active-child", "");
    const reconstruct = reconstructId
      ? (captured.prepare(
          "SELECT id, status, parent_thread_id AS parent, child_session_id AS child FROM agent_runs WHERE id = ?",
        ).get(reconstructId) as unknown as { id: string; status: string; parent: string | null; child: string | null } | undefined)
      : undefined;
    captured.close();

    const replayDb = new DatabaseSync(join(sandbox.ooHome, "state.db"));
    const restore = replayDb.prepare(
      "UPDATE agent_runs SET status = 'running', finished_at = NULL, error = NULL, last_activity_at = ? WHERE id = ?",
    );
    const now = new Date().toISOString();
    for (const run of [...live, ...(reconstruct ? [reconstruct] : [])]) restore.run(now, run.id);
    replayDb.close();
    write("runs.json", {
      capturedLive: live.map((run) => ({ ...run, provenance: "captured as live" })),
      reconstructed: reconstruct ? [{ ...reconstruct, capturedStatus: reconstruct.status, provenance: "reconstructed as running" }] : [],
    });
  }

  // ---- observation ------------------------------------------------------------------
  const observeStart = Date.now();
  await daemon.monitor.poll();
  const observeMs = Date.now() - observeStart;
  const observed = daemon.state.listCurrentSessionState();
  write("observed.json", { observeMs, rows: observed.length, sessions: observed });

  // A poll queues work; the owner waits for the queue. Both the timeline and the successive
  // positions below measure from the poll that queued it until nothing is eligible.
  const drainQueue = async (since: number, onChange: () => boolean): Promise<number> => {
    const deadline = Date.now() + Number(flag("enrich-timeout-s", "900")) * 1_000;
    let quietSince = Date.now();
    let remaining = Number.POSITIVE_INFINITY;
    while (Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 250));
      const eligible = daemon!.state.listEnrichmentCandidates().length;
      // A long queue is still working even when the rows on screen have not changed yet, so
      // progress counts as the queue shrinking or a row changing.
      if (onChange() || eligible < remaining) quietSince = Date.now();
      remaining = eligible;
      // Finished when nothing is eligible, or when nothing has moved for long enough that the
      // remaining candidates are the ones this version cannot serve.
      if (eligible === 0 || Date.now() - quietSince > 30_000) break;
    }
    return Date.now() - since;
  };

  // ---- successive positions ------------------------------------------------------------
  // Each step shows the daemon one captured conversation as it stood earlier, then lets its own
  // queue assess it. Repeating that writes the status-summary history the acceptance needs from
  // real transcript positions, rather than waiting for a future capture to contain one.
  const positions = Number(flag("successive", "0"));
  if (positions > 1) {
    const sandboxFiles = new Map<string, string>();
    const walkTranscripts = (base: string): void => {
      for (const entry of readdirSync(base, { withFileTypes: true, recursive: true })) {
        const path = join(entry.parentPath ?? base, entry.name);
        if (entry.isFile() && (path.endsWith(".jsonl") || path.endsWith(".ndjson"))) sandboxFiles.set(basename(path), path);
      }
    };
    walkTranscripts(join(sandbox.ooHome, "sessions"));
    walkTranscripts(join(root, "transcripts"));

    const replayDb = new DatabaseSync(join(sandbox.ooHome, "state.db"), { readOnly: true });
    const pathOf = new Map((replayDb.prepare("SELECT id, transcript_path AS path FROM threads WHERE transcript_path IS NOT NULL")
      .all() as unknown as Array<{ id: string; path: string }>).map((row) => [row.id, basename(row.path)] as const));
    replayDb.close();

    const requested = flag("successive-threads", "").split(",").map((value) => value.trim()).filter(Boolean);
    const selected = (requested.length
      ? requested
      : observed.slice(0, Number(flag("successive-limit", "4"))).map((row) => row.id))
      .flatMap((id) => {
        const file = pathOf.get(id) && sandboxFiles.get(pathOf.get(id)!);
        if (!file) return [];
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
        return [{ id, file, lines }];
      });

    const steps: Array<Record<string, unknown>> = [];
    for (let position = 1; position <= positions; position += 1) {
      for (const { file, lines } of selected) {
        const prefix = prefixAt(lines, position, positions);
        const stamp = new Date();
        writeFileSync(file, `${shiftTo(prefix, stamp.getTime()).join("\n")}\n`);
        utimesSync(file, stamp, stamp);
      }
      const started = Date.now();
      await daemon.monitor.poll();
      const drainedMs = await drainQueue(started, () => false);
      const ledger = new DatabaseSync(join(sandbox.ooHome, "state.db"), { readOnly: true });
      const columns = (ledger.prepare("PRAGMA table_info(thread_details)").all() as unknown as Array<{ name: string }>)
        .map((column) => column.name);
      const rows = daemon.state.listCurrentSessionState();
      steps.push({
        position, positions, drainedMs,
        sessions: selected.map(({ id, lines }) => {
          const row = rows.find((candidate) => candidate.id === id);
          const revisions = ledger.prepare(
            `SELECT ${columns.join(", ")} FROM thread_details WHERE thread_id = ? ORDER BY version`,
          ).all(id);
          return {
            id,
            linesShown: prefixAt(lines, position, positions).length,
            row: row && {
              state: row.state, shownTitle: row.topic, generatedTopic: row.generatedTopic,
              summary: row.summary, parentThreadId: row.parentThreadId,
              ...("summaryPending" in row ? { summaryPending: (row as { summaryPending?: boolean }).summaryPending } : {}),
            },
            revisions,
          };
        }),
      });
      ledger.close();

      // A bookmark is only useful if it leads back to the evidence. Resolve the newest one
      // through the same privacy-aware helper OO would use, and record what it lands on.
      const step = steps.at(-1)!;
      for (const session of step.sessions as Array<{ id: string; revisions: Array<Record<string, unknown>>; bookmarkRead?: unknown }>) {
        const newest = [...session.revisions].reverse().find((revision) => revision.bookmark_index !== null && revision.written_by === "model");
        if (!newest) continue;
        try {
          const read = execFileSync(process.execPath, [
            join(armRoot, "src", "agent", "skills", "session-search", "scripts", "session-search.mjs"),
            "--session", session.id, "--at", String(newest.bookmark_index), "--include-tools", "--before", "0", "--after", "0", "--max-chars", "1200",
          ], { encoding: "utf8", env: { ...process.env, OO_INSTALL_ROOT: armRoot } });
          session.bookmarkRead = {
            index: newest.bookmark_index,
            header: read.split("\n", 1)[0],
            landedOn: read.split("\n").slice(1).join(" ").trim().slice(0, 160),
          };
        } catch (error) {
          session.bookmarkRead = { index: newest.bookmark_index, error: String((error as { stderr?: string }).stderr ?? error).slice(0, 200) };
        }
      }
      process.stderr.write(`position ${position}/${positions} drained in ${(drainedMs / 1_000).toFixed(1)}s\n`);
    }
    write("successive.json", { positions, threads: selected.map(({ id }) => id), steps });
  }

  // ---- enrichment, as the daemon runs it ----------------------------------------------
  // What the owner waits for is a row changing on screen, so the measurement watches the
  // projection while the daemon's queue works: one entry per visible change, timed from the
  // poll that queued the work.
  if (has("daemon-enrich")) {
    const timeline: Array<Record<string, unknown>> = [];
    const seen = new Map<string, string>();
    const snapshot = (): boolean => {
      const before = timeline.length;
      for (const row of daemon!.state.listCurrentSessionState()) {
        const shape = JSON.stringify([row.state, row.generatedTopic, row.ownerTitle, row.summary, row.topic]);
        if (seen.get(row.id) === shape) continue;
        seen.set(row.id, shape);
        timeline.push({
          atMs: Date.now() - observeStart, id: row.id, source: row.source, state: row.state,
          generatedTopic: row.generatedTopic, ownerTitle: row.ownerTitle,
          summary: row.summary, shownTitle: row.topic,
          ...("summaryPending" in row ? { summaryPending: (row as { summaryPending?: boolean }).summaryPending } : {}),
        });
      }
      return timeline.length !== before;
    };
    snapshot();
    await drainQueue(observeStart, snapshot);
    write("timeline.json", {
      observedAt: new Date(observeStart).toISOString(),
      watchedMs: Date.now() - observeStart,
      rows: observed.length,
      remainingCandidates: daemon.state.listEnrichmentCandidates().map((row) => row.id),
      timeline,
    });
  }

  // ---- enrichment, driven one call at a time ------------------------------------------
  const candidates = has("daemon-enrich") ? [] : daemon.state.listEnrichmentCandidates();
  const selected = threadLimit > 0 ? candidates.slice(0, threadLimit) : candidates;
  const attempts: Array<Record<string, unknown>> = [];
  if (!has("no-enrich") && !has("daemon-enrich")) {
    for (const candidate of selected) {
      const started = Date.now();
      const attempt: Record<string, unknown> = {
        id: candidate.id, source: candidate.source, state: candidate.state,
        children: candidate.children.length, lastMessageAt: candidate.lastMessageAt,
      };
      try {
        const { sample, bookmark } = await sampleEnrichment(candidate);
        attempt.sampleChars = sample.length;
        attempt.sampleMs = Date.now() - started;
        attempt.bookmark = bookmark;
        if (has("sample-only")) { attempts.push(attempt); continue; }
        const modelStart = Date.now();
        attempt.currentTitle = candidate.generatedTopic;
        const details = await enrichThread(sample, {
          currentTitle: candidate.generatedTopic,
          currentStatusSummary: candidate.summary,
        });
        attempt.modelMs = Date.now() - modelStart;
        attempt.details = details;
        attempt.applied = daemon.state.appendEnrichment(
          candidate.id, details, candidate.lastMessageAt!, candidate.children,
        );
      } catch (error) {
        attempt.error = error instanceof Error ? error.message : String(error);
      }
      attempt.totalMs = Date.now() - started;
      attempts.push(attempt);
      process.stderr.write(`${attempts.length}/${selected.length} ${candidate.id} ${attempt.error ? `FAILED ${attempt.error}` : "ok"}\n`);
    }
  }
  write("enrichment.json", {
    candidates: candidates.length,
    attempted: attempts.length,
    applied: attempts.filter((attempt) => attempt.applied).length,
    failed: attempts.filter((attempt) => attempt.error).length,
    totalMs: attempts.reduce((sum, attempt) => sum + Number(attempt.totalMs ?? 0), 0),
    attempts,
  });

  // ---- what a client would see ------------------------------------------------------
  const response = await fetch(`http://127.0.0.1:${daemon.port}/session-state`, {
    headers: { authorization: `Bearer ${JSON.parse(execFileSync("cat", [join(sandbox.ooHome, "daemon.json")], { encoding: "utf8" })).authToken}` },
  });
  write("session-state.gateway.json", await response.json());
  write("monitor-log.json", monitorLog);
  write("daemon.json", { port: daemon.port, ooHome: sandbox.ooHome });

  // ---- what the widget draws -----------------------------------------------------------
  // The native client connects to this daemon and renders the replayed rows, so the title,
  // recap, and working rules are checked in the real view rather than in a snapshot of it.
  const nativeBinary = flag("native", "");
  if (nativeBinary) {
    const ready = await fetch(`http://127.0.0.1:${daemon.port}/ready`, {
      headers: { authorization: `Bearer ${JSON.parse(readFileSync(join(sandbox.ooHome, "daemon.json"), "utf8")).authToken}` },
    });
    write("ready.json", await ready.json());
    const expected = join(out, "native-expected.json");
    writeFileSync(expected, `${JSON.stringify(daemon.state.listCurrentSessionState())}\n`);
    // The daemon serving this proof lives in this process, so the native client is awaited
    // rather than run synchronously: a blocked event loop cannot answer its requests.
    const proof = await promisify(execFile)(resolve(nativeBinary), [expected, join(out, "native")], {
      encoding: "utf8", timeout: 5 * 60 * 1_000, env: { ...process.env },
    }).catch((error: { stdout?: string; stderr?: string; message: string }) => {
      write("native.log", `${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`);
      throw new Error(`the native widget proof failed: ${(error.stderr || error.message).slice(-2_000)}`);
    });
    write("native.log", `${proof.stdout}${proof.stderr}`);
  }

  // ---- what the owner gets when they ask ----------------------------------------------
  // The production `oo` binary answers against this replayed state, so the answers and the
  // tools it reached for are the ones the owner would get from the same question today.
  const askFile = flag("ask", "");
  if (askFile) {
    const questions = JSON.parse(readFileSync(resolve(askFile), "utf8")) as Array<{ id: string; question: string }>;
    const answers: Array<Record<string, unknown>> = [];
    // `oo` connects to the daemon it can verify and supervise, so the replayed state moves
    // into the eval harness's own daemon process before the questions start. It is model-free:
    // the answers must come from the state this run already produced.
    await daemon.close();
    daemon = undefined;
    askDaemon = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "providers", "eval-daemon.mjs")], {
      cwd: join(import.meta.dirname, "..", ".."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const discovery = join(sandbox.ooHome, "daemon.json");
    for (let attempt = 0; attempt < 200 && !askPort; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
      if (askDaemon.exitCode !== null) throw new Error("the replay question daemon exited before it was ready");
      try {
        const info = JSON.parse(readFileSync(discovery, "utf8")) as { port: number; pid: number; authToken: string };
        const ready = await fetch(`http://127.0.0.1:${info.port}/ready`, {
          headers: { authorization: `Bearer ${info.authToken}` }, signal: AbortSignal.timeout(500),
        });
        if (ready.ok && (await ready.json()).ready && info.pid === askDaemon.pid) askPort = info.port;
      } catch { /* still starting */ }
    }
    if (!askPort) throw new Error("the replay question daemon did not become ready");
    for (const { id, question } of questions) {
      const trace = join(out, `${id}.trace.ndjson`);
      const started = Date.now();
      const result = spawnSync(process.execPath, [
        "--import", "tsx", join(armRoot, "src", "cli", "oo.ts"), question,
      ], {
        cwd: armRoot,
        encoding: "utf8",
        timeout: 10 * 60 * 1_000,
        env: { ...process.env, OO_TRACE: trace, OO_EVAL_READ_ONLY: "1" },
      });
      const events = existsSync(trace)
        ? readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        : [];
      answers.push({
        id, question, ms: Date.now() - started,
        answer: result.stdout?.trim() ?? "",
        error: result.status === 0 ? undefined : (result.stderr || `exit ${result.status}`).slice(0, 2_000),
        toolCalls: events.filter((event) => event.event === "tool_call").map((event) => event.tool),
        // Every product checkout on this machine ships the same helper under a different path,
        // so a bash call naming one of the others answered from that version, not this arm's.
        foreignCheckoutCalls: events
          .filter((event) => event.event === "tool_call" && event.tool === "bash")
          .map((event) => String((event.args as { command?: string })?.command ?? ""))
          .filter((command) => otherCheckouts.some((path) => command.includes(path))),
        turns: events.filter((event) => event.event === "turn").length,
        tokens: events.filter((event) => event.event === "turn")
          .reduce((sum, event) => sum + Number((event.usage as { totalTokens?: number })?.totalTokens ?? 0), 0),
        cost: events.filter((event) => event.event === "turn")
          .reduce((sum, event) => sum + Number((event.usage as { cost?: { total?: number } })?.cost?.total ?? 0), 0),
      });
      process.stderr.write(`asked ${id} (${answers.at(-1)!.ms}ms)\n`);
    }
    write("answers.json", answers);
  }
} catch (error) {
  failure = error;
  write("failure.json", { error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
} finally {
  const closed = await closeSandboxUser(sandbox, daemon?.port ?? askPort, async () => {
    await daemon?.close();
    if (askDaemon && askDaemon.exitCode === null) {
      askDaemon.kill("SIGTERM");
      await new Promise((settle) => askDaemon!.once("exit", settle));
    }
  }, { kind: "replay", label });
  write("teardown.json", closed);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previousEnvironment);
  if (!closed.teardownVerified) process.exitCode = 2;
  if (failure) process.exitCode = 1;
  else process.stderr.write(`replay artifacts: ${out}\n`);
}

// Teardown runs first and reports itself; the replay's own failure is the exit reason.
if (failure) throw failure;

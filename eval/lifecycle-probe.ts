// Watch one session and one delegated child move through the lifecycle on a real daemon with
// the transcript watcher armed and the production enrichment composition, recording when each
// visible change lands and what the real widget draws after each step.
//
//   node --import tsx eval/lifecycle-probe.ts --out <dir> [--native <LiveSummaryProof binary>]
//
// Steps: a new session appears; its turn ends; it delegates a child; the child completes; the
// child is followed up after completion. Each step writes <out>/<nn>-<step>.json (rows and
// timings) and, with --native, <out>/<nn>-<step>-*.png from the widget.

import { mkdirSync, writeFileSync, utimesSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentRunHarness, AgentRunStatus, type SessionStateRow } from "@owner-operator/core";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { evalSandboxPath } from "./sandbox.mjs";
import { materializeSandboxUser, closeSandboxUser } from "./sandbox-user";

const args = process.argv.slice(2);
const flag = (name: string): string => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? "" : args[index + 1] ?? "";
};
const out = resolve(flag("out") || (() => { throw new Error("--out is required"); })());
const nativeBinary = flag("native");
mkdirSync(out, { recursive: true });

const originalEnvironment = { ...process.env };
const sandbox = materializeSandboxUser({
  profile: "deterministic-harness",
  root: evalSandboxPath(`lifecycle-${randomUUID()}`),
  sourcePiAgentDir: join(homedir(), ".owner-operator", "pi"),
  modelSettings: { defaultProvider: "openai-codex", defaultModel: "gpt-5.6-luna", defaultThinkingLevel: "medium" },
});
let daemon: RunningDaemon | undefined;
const report: Array<Record<string, unknown>> = [];
const t0 = Date.now();
const since = () => Date.now() - t0;

try {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, sandbox.env);
  writeFileSync(join(sandbox.ooHome, "settings.json"), JSON.stringify({ activeWindow: "1d" }));
  writeFileSync(sandbox.paths.sessionSources, JSON.stringify({ disable: ["claude", "pi", "cursor", "posthog-code", "opencode", "antigravity", "grok-build"], add: [] }));
  const project = sandbox.taskCwd;
  const codexRoot = join(process.env.HOME!, ".codex", "sessions");
  mkdirSync(codexRoot, { recursive: true });

  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  const meta = (id: string) => line({ type: "session_meta", payload: { id, cwd: project, source: "cli" } });
  const message = (role: "user" | "assistant", text: string) =>
    line({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "message", role, content: [{ text }] } });
  const lifecycle = (type: "task_started" | "task_complete") =>
    line({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type } });
  const file = (id: string) => join(codexRoot, `${id}.jsonl`);
  const touch = (id: string) => { const now = new Date(); utimesSync(file(id), now, now); };

  const rows = () => daemon!.state.listCurrentSessionState();
  const row = (id: string) => rows().find((r) => r.id === id);
  async function until(what: string, test: () => boolean, ms = 120_000): Promise<number> {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (test()) return Date.now() - started;
      await new Promise((r) => setTimeout(r, 200));
    }
    return -1;
  }
  const view = (r: SessionStateRow | undefined) => r && {
    id: r.id, title: r.topic, generatedTopic: r.generatedTopic, state: r.state, summary: r.summary,
    summaryPending: r.summaryPending, parentThreadId: r.parentThreadId ?? null,
  };
  let step = 0;
  async function record(name: string, timings: Record<string, number>, note?: string) {
    step += 1;
    const label = `${String(step).padStart(2, "0")}-${name}`;
    const current = rows();
    const entry = { step: label, atMs: since(), timings, note, rows: current.map(view) };
    report.push(entry);
    writeFileSync(join(out, `${label}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    console.log(label, JSON.stringify(timings), note ?? "");
    for (const r of current) console.log(`   ${r.id.padEnd(8)} ${r.state.padEnd(9)} pending=${r.summaryPending} | ${r.topic} | ${r.summary ?? "(none yet)"}`);
    if (!nativeBinary) return;
    const expected = join(sandbox.tempDir, `${label}.json`);
    writeFileSync(expected, JSON.stringify(current));
    const result = await promisify(execFile)(nativeBinary, [expected, join(out, label)], { env: process.env, timeout: 60_000 })
      .catch((error: { stdout?: string; stderr?: string; message: string }) => ({ stdout: error.stdout ?? "", stderr: `${error.stderr ?? ""}${error.message}` }));
    writeFileSync(join(out, `${label}-native.log`), `${result.stdout}${result.stderr}`);
  }

  daemon = await startDaemon({
    port: 0, watch: true, dbPath: join(sandbox.ooHome, "state.db"),
    agentRuns: { launcher: async () => { throw new Error("probe never launches an agent"); } },
    monitor: { intervalMs: 15_000 },
  });
  await daemon.monitor.poll();
  await record("daemon-idle", {}, "no sessions yet; watcher armed");

  // 1. A brand-new session starts a turn.
  const fresh = "fresh1";
  const born = Date.now();
  writeFileSync(file(fresh), meta(fresh) + message("user", "Add retry with backoff to the webhook sender and cover it with tests.") + lifecycle("task_started"));
  touch(fresh);
  const rowMs = await until("row appears", () => Boolean(row(fresh)));
  const titleMs = await until("generated title", () => Boolean(row(fresh)?.generatedTopic));
  const summaryMs = await until("first summary", () => Boolean(row(fresh)?.summary));
  await record("new-session", { rowVisibleMs: rowMs, titleMs: titleMs < 0 ? -1 : rowMs + titleMs, summaryMs: summaryMs < 0 ? -1 : rowMs + titleMs + summaryMs, sinceBornMs: Date.now() - born },
    "times from the transcript file being written");

  // 2. The turn ends.
  const beforeEnd = row(fresh)?.summary;
  appendFileSync(file(fresh), message("assistant", "Retry with exponential backoff added to WebhookSender; 4 tests pass, including the max-attempts case.") + lifecycle("task_complete"));
  touch(fresh);
  const idleMs = await until("idle", () => row(fresh)?.state === "idle");
  const refreshedMs = await until("summary refreshed", () => row(fresh)?.summary !== beforeEnd && row(fresh)?.summaryPending === false);
  await record("turn-ended", { idleMs, summaryRefreshedMs: refreshedMs });

  // 3. The session delegates a child.
  const kid = "kid1";
  const run = daemon.state.createAgentRun({ harness: AgentRunHarness.Codex, task: "Review the retry implementation against the spec.", cwd: project, parentThreadId: fresh, childSessionId: kid, depth: 1, timeoutSeconds: 600 });
  daemon.state.claimNextPendingAgentRun(1);
  daemon.state.recordAgentRunActivity(run.id, { childSessionId: kid });
  writeFileSync(file(kid), meta(kid) + message("user", "Review the retry implementation against the spec.") + lifecycle("task_started"));
  touch(kid);
  const childRowMs = await until("child row", () => Boolean(row(kid)));
  const parentWorkingMs = await until("parent working", () => row(fresh)?.state === "working");
  const childTitleMs = await until("child title", () => Boolean(row(kid)?.generatedTopic));
  await record("child-running", { childRowMs, parentWorkingMs, childTitleMs, childParent: row(kid)?.parentThreadId === fresh ? 1 : 0 });

  // 4. The child completes.
  const parentBefore = row(fresh)?.summary;
  appendFileSync(file(kid), message("assistant", "Review complete. Backoff schedule matches the spec; one nit: jitter is not applied. No blocking findings.") + lifecycle("task_complete"));
  touch(kid);
  daemon.state.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: "Review complete. No blocking findings.", error: null });
  await daemon.monitor.poll();
  const parentIdleMs = await until("parent leaves working", () => row(fresh)?.state !== "working");
  const parentRefreshMs = await until("parent summary refreshed", () => row(fresh)?.summary !== parentBefore && row(fresh)?.summaryPending === false);
  await record("child-completed", { parentLeftWorkingMs: parentIdleMs, parentSummaryRefreshedMs: parentRefreshMs });

  // 5. The child is followed up after completion.
  const parentAfterChild = row(fresh)?.summary;
  appendFileSync(file(kid), message("user", "Apply the jitter nit and rerun the tests.") + lifecycle("task_started"));
  touch(kid);
  const childWorkingMs = await until("child working again", () => row(kid)?.state === "working");
  const parentWorkingAgainMs = await until("parent working again", () => row(fresh)?.state === "working", 30_000);
  const parentRefreshAgainMs = await until("parent summary refreshed again", () => row(fresh)?.summary !== parentAfterChild && row(fresh)?.summaryPending === false, 90_000);
  await record("child-followed-up", { childWorkingMs, parentWorkingAgainMs, parentSummaryRefreshedMs: parentRefreshAgainMs },
    "a completed run has a terminal status, so the parent's working state depends on the child's own transcript only if the code accounts for it");

  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
} finally {
  const port = daemon?.port;
  const running = daemon;
  daemon = undefined;
  const closed = await closeSandboxUser(sandbox, port, async () => { await running?.close(); });
  writeFileSync(join(out, "teardown.json"), `${JSON.stringify(closed, null, 2)}\n`);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);

}

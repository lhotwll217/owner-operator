import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { AgentRunHarness, AgentRunStatus, type EnrichmentCandidate, type ThreadEnrichment, type SessionStateRow } from "@owner-operator/core";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { State } from "../src/state/state";
import { fakeScanRow, waitFor } from "../src/gateway/test/helpers";
import { evalSandboxPath, sanitizeEvalDiagnosticValue } from "../eval/sandbox.mjs";
import { materializeSandboxUser, loadSandboxPiServices, closeSandboxUser } from "../eval/sandbox-user";

export async function runSessionStateWidgetProof(options: {
  live?: { credentialSource: string; loadEnrichment?: () => Promise<typeof import("../src/agent/enrichment").enrichThread> };
  nativeBinary?: string;
  outputDirectory?: string;
  root?: string;
  enrich?: (candidate: EnrichmentCandidate, sample: string) => Promise<ThreadEnrichment>;
} = {}) {
  const originalEnvironment = { ...process.env };
  const live = Boolean(options.live);
  const credentialSource = options.live?.credentialSource;
  const { nativeBinary, outputDirectory } = options;
  if (nativeBinary && !outputDirectory) throw new Error("native proof requires an output directory");
  if (live && !credentialSource) throw new Error("live proof requires an explicit credential source directory");
  const sandbox = materializeSandboxUser({
    profile: "deterministic-harness",
    root: options.root ?? evalSandboxPath(`widget-proof-${randomUUID()}`),
    ...(credentialSource ? { sourcePiAgentDir: credentialSource, modelSettings: {
      defaultProvider: "openai-codex", defaultModel: "gpt-5.6-luna", defaultThinkingLevel: "medium",
    } } : {}),
  });
  const safe = <T,>(value: T) => sanitizeEvalDiagnosticValue(value, sandbox.diagnosticRedactions);
  let daemon: RunningDaemon | undefined;
  let seed: State | undefined;
  let restoreModel = () => {};
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, sandbox.env);
    writeFileSync(join(sandbox.ooHome, "settings.json"), JSON.stringify({ activeWindow: "1d" }));
    writeFileSync(sandbox.paths.sessionSources, JSON.stringify({ disable: ["cursor", "posthog-code", "opencode", "antigravity", "grok-build"], add: [] }));
    const dbPath = join(process.env.OO_HOME, "state.db");
    const project = sandbox.taskCwd;
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const oldAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const cases = [
      { id: "first-message", request: "Implement CSV export for invoices.", answer: "", state: "idle", topic: "Invoice CSV export" },
      { id: "child", request: "Review the implementation against the spec. Report findings. Do not implement anything.", answer: "Review complete. No findings. All requested checks passed. No remaining work or owner decision.", state: "idle", topic: "Completed spec review" },
      { id: "decision", request: "Build the export.", answer: "Implementation requires the retention policy. Should exports retain 30 or 90 days? The owner must choose before work can continue.", state: "needs-you", topic: "Export retention decision" },
      { id: "partial", request: "Implement and verify the export.", answer: "I have started reading the files. Implementation and verification are not complete. I have no question for the owner yet.", state: "idle", topic: "Unfinished export implementation" },
      { id: "summarized", request: "Remove the unused import and run the typecheck.", answer: "The unused import is removed and typecheck passed. The requested task is complete with no remaining work or required owner action.", state: "idle", topic: "Completed import cleanup" },
      { id: "owner-done", request: "Investigate an optional follow-up.", answer: "I can investigate further.", state: "idle", topic: "Owner dismissed follow-up" },
    ] as const;
    function transcript(id: string, request: string, answer: string, timestamp = at, working = false) {
      const file = join(process.env.HOME!, ".codex", "sessions", `${id}.jsonl`);
      mkdirSync(dirname(file), { recursive: true });
      const records = [
        { type: "session_meta", payload: { id, cwd: project, source: "cli" } },
        { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ text: request }] } },
        ...(id === "child" || id === "summarized" ? [
          { type: "response_item", timestamp, payload: { type: "function_call", name: "exec_command", call_id: `${id}-check`, arguments: JSON.stringify({ cmd: id === "child" ? "cat spec.md; git diff; npm test" : "git diff -- src/export.ts; npm run typecheck" }) } },
          { type: "response_item", timestamp, payload: { type: "function_call_output", call_id: `${id}-check`, output: id === "child" ? "spec.md: Export retains exactly 30 days.\nDiff: retainDays changed from 90 to 30. No other changes.\nPASS export retention matches spec: 30 days. Tests 1 passed, 0 failed. Exit code 0." : "diff --git a/src/export.ts b/src/export.ts\n-import { unused } from './unused';\nRemaining code unchanged.\n> tsc --noEmit\nExit code 0. No errors." } },
        ] : []),
        ...(answer ? [{ type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ text: answer }] } }] : []),
        { type: "event_msg", timestamp, payload: { type: working ? "task_started" : "task_complete" } },
      ];
      writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      utimesSync(file, new Date(timestamp), new Date(timestamp));
    }
    for (const c of cases.filter((item) => item.id !== "partial" && item.id !== "decision")) transcript(c.id, c.request, c.answer, at, c.id === "first-message");
    for (const id of ["partial", "parent"]) {
      const file = join(process.env.OO_HOME!, "sessions", `${id}.jsonl`);
      mkdirSync(dirname(file), { recursive: true });
      const c = cases.find((item) => item.id === id);
      writeFileSync(file, [
        { type: "session", version: 3, id, timestamp: at, cwd: project },
        { type: "custom", customType: "oo-provenance", timestamp: at, data: { surface: "chat", origin: "owner", callerCwd: project, callerRepo: "demo", ppid: 1 } },
        { type: "message", timestamp: at, message: { role: "user", content: c?.request ?? "Use the replacement agent." } },
        { type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: c?.answer ?? "The replacement is working." }], stopReason: id === "parent" ? "toolUse" : "stop" } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
    const decision = cases.find((c) => c.id === "decision")!;
    const claudeFile = join(process.env.HOME!, ".claude", "projects", "demo", "decision.jsonl");
    mkdirSync(dirname(claudeFile), { recursive: true });
    writeFileSync(claudeFile, [
      { type: "user", entrypoint: "claude-desktop", sessionId: "decision", cwd: project, timestamp: at, message: { content: decision.request } },
      { type: "assistant", sessionId: "decision", timestamp: at, message: { content: [{ type: "text", text: decision.answer }], stop_reason: "end_turn" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    transcript("outside-window", "Old quiet investigation", "No decision requested", oldAt);
    seed = new State(dbPath);
    for (const id of [...cases.map((c) => c.id), "parent", "outside-window"]) {
      const timestamp = id === "outside-window" ? oldAt : at;
      seed.recordObservation(fakeScanRow({ id, project, source: "codex", lastMessageAt: timestamp, createdAt: timestamp, secondsSinceLastMessage: 7200 }));
    }
    for (const id of ["parent", "summarized"]) {
      assert.ok(seed.appendEnrichment(id, { topic: "Stale review instruction", summary: "Review and confirm the task", priority: 2, attention: "needs-you" as const }, at));
    }
    seed.markThreadsDone(["owner-done"]);
    const run = seed.createAgentRun({ harness: AgentRunHarness.Codex, task: "Review the implementation", cwd: project, parentThreadId: "parent", childSessionId: "child", depth: 1, timeoutSeconds: 60 });
    seed.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: "Review complete. No findings.", error: null });
    console.log("BEFORE", JSON.stringify(seed.listCurrentSessionState().map((r) => ({ id: r.id, title: r.topic, state: r.state, summary: r.summary }))));
    const windowPreserved = !seed.listCurrentSessionState().some((r) => r.id === "outside-window");
    seed.close();
    seed = undefined;
    let enabled = false;
    let failOnce = true;
    const attempts: string[] = [];
    const errors: string[] = [];
    const liveEnrich = live ? await (options.live?.loadEnrichment ?? (async () => (await import("../src/agent/enrichment")).enrichThread))() : undefined;
    const services = live ? await loadSandboxPiServices(sandbox) : undefined;
    let modelCalls = 0;
    if (live) {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const complete = ModelRuntime.prototype.completeSimple;
      restoreModel = () => { ModelRuntime.prototype.completeSimple = complete; };
      ModelRuntime.prototype.completeSimple = async function (model, context, options) {
        assert.ok(sandbox.credentialFilesUnavailable(), "copied credentials and config are gone before every inference");
        assert.equal(model.provider, "openai-codex");
        assert.equal(model.id, "gpt-5.6-luna");
        assert.equal(options?.reasoning, "medium");
        console.log("MODEL_IDENTITY", model.provider, model.id, options?.reasoning);
        modelCalls++;
        return complete.call(this, model, context, options);
      };
    }
    async function enrich(candidate: EnrichmentCandidate): Promise<ThreadEnrichment> {
      attempts.push(candidate.id);
      if (candidate.id === "partial" && failOnce) { failOnce = false; throw new Error("controlled transient outage"); }
      const { sampleEnrichment } = await import("../src/session-monitor/scan");
      const sample = await sampleEnrichment(candidate);
      if (candidate.id === "parent") {
        assert.ok(sample.includes("Use the replacement agent."), "working summary sees the first owner message");
        assert.ok(sample.includes("Continue with the replacement"), "working summary sees the latest owner message");
        assert.ok(sample.includes("Delegated child child"), "parent summary receives the child's own evidence");
      }
      if (liveEnrich) {
        const result = await liveEnrich(sample, services);
        console.log("MODEL", candidate.id, JSON.stringify(safe(result)));
        return result;
      }
      if (options.enrich) return options.enrich(candidate, sample);
      if (candidate.id === "parent") {
        return { topic: "Replacement agent run", attention: "idle", priority: 3, summary: sample.includes("CSV escaping verified")
          ? "Child review verified CSV escaping; implementation continues."
          : "Child review passed; the replacement agent is implementing the task." };
      }
      const c = cases.find((item) => item.id === candidate.id);
      assert.ok(c, `unexpected reconciliation outside the visible test set: ${candidate.id}`);
      if (candidate.id === "child" || candidate.id === "summarized") {
        assert.ok(sample.includes("Exit code 0"), "reconciliation receives execution evidence, not just the assistant's completion claim");
      }
      return { topic: c.topic, attention: c.state, priority: 2, summary: c.answer || (sample.includes("CSV writer implemented") ? "CSV writer implemented; tests are next." : "Implementing invoice CSV export.") };
    }
    async function boot() {
      return startDaemon({ port: 0, watch: false, dbPath,
        agentRuns: { launcher: async () => { throw new Error("proof must never launch an agent"); } },
        monitor: { intervalMs: 60_000, canEnrich: () => enabled, enrich, logger: (r) => errors.push(r.error) },
      });
    }
    async function api(path: string, body?: unknown) {
      const info = JSON.parse(readFileSync(join(process.env.OO_HOME!, "daemon.json"), "utf8"));
      const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${info.authToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 200, path);
      return response.json();
    }
    async function nativeProof(label: string, rows: SessionStateRow[]) {
      assert.equal((await api("/ready")).ready, true, "proof daemon must remain ready on the tested source tree");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        for (const row of rows) {
          const stored = db.prepare("SELECT summary FROM thread_details WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(row.id);
          assert.equal(stored?.summary, row.summary, `database summary reaches Gateway for ${row.id}`);
        }
      } finally { db.close(); }
      if (!nativeBinary || !outputDirectory) return;
      mkdirSync(outputDirectory, { recursive: true });
      const expected = join(sandbox.tempDir, `${label}.json`);
      writeFileSync(expected, JSON.stringify(rows));
      writeFileSync(join(outputDirectory, `${label}.json`), JSON.stringify(safe(rows), null, 2));
      const result = await promisify(execFile)(nativeBinary, [expected, join(outputDirectory, label)], { env: process.env, timeout: 30_000 });
      writeFileSync(join(outputDirectory, `${label}-native.log`), String(safe(result.stdout + result.stderr)));
      console.log("CHECKPOINT", label, new Date().toISOString(), safe(result.stdout));
    }
    assert.ok(windowPreserved, "configured widget window must not widen");
    daemon = await boot();
    await daemon.agentRuns.stop();
    const activeChild = daemon.state.createAgentRun({ harness: AgentRunHarness.Codex, task: "Implement export", cwd: project, parentThreadId: "parent", depth: 1, timeoutSeconds: 600 });
    await api("/poll", {});
    await waitFor(() => daemon!.state.listCurrentSessionState().some((r) => r.id === "partial" && r.app === "Owner Operator"), 10_000, "startup scan observes real transcripts");
    const before: SessionStateRow[] = await api("/session-state");
    assert.equal(before.find((r) => r.id === "partial")?.app, "Owner Operator", "real OO transcript adapter participates in recovery");
    assert.equal(before.find((r) => r.id === "decision")?.source, "claude", "real Claude transcript adapter participates in recovery");
    assert.ok(before.some((r) => r.id === "child" && r.parentThreadId === "parent" && !r.generatedTopic), "stale delegated child is actually in the widget response before recovery");
    assert.ok(before.find((r) => r.id === "parent")?.summary, "working parent has a transcript fallback before enrichment");
    enabled = true;
    const parentAt = new Date().toISOString();
    const parentFile = join(process.env.OO_HOME!, "sessions", "parent.jsonl");
    writeFileSync(parentFile, [
      { type: "session", version: 3, id: "parent", timestamp: at, cwd: project },
      { type: "custom", customType: "oo-provenance", timestamp: at, data: { surface: "chat", origin: "owner", callerCwd: project, callerRepo: "demo", ppid: 1 } },
      { type: "message", timestamp: at, message: { role: "user", content: "Use the replacement agent." } },
      { type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "The replacement is working." }], stopReason: "toolUse" } },
      { type: "message", timestamp: parentAt, message: { role: "user", content: "Continue with the replacement and report progress." } },
      { type: "message", timestamp: parentAt, message: { role: "assistant", content: [{ type: "text", text: "Continuing with the replacement; implementation is underway." }], stopReason: "toolUse" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const recovery = await api("/poll", { reconcile: [{ id: "summarized", lastMessageAt: at }, { id: "outside-window", lastMessageAt: oldAt }, { id: "owner-done", lastMessageAt: at }] });
    assert.deepEqual(recovery.queuedIds, ["summarized"], "recovery touches only eligible visible rows");
    await waitFor(() => errors.some((e) => e.includes("controlled transient outage")), live ? 180_000 : 10_000, "first failed idle reconciliation");
    await waitFor(() => daemon!.state.listEnrichmentCandidates().length === 1, live ? 180_000 : 10_000, "first pass drains except failed partial work");
    await api("/poll", {});
    await waitFor(() => daemon!.state.listEnrichmentCandidates().length === 0, live ? 90_000 : 10_000, "failed idle row retries");
    const after: SessionStateRow[] = await api("/session-state");
    console.log("AFTER", JSON.stringify(safe(after.map((r) => ({ id: r.id, title: r.topic, state: r.state, summary: r.summary })))));
    assert.deepEqual(after.map((r) => r.id).sort(), ["child", "decision", "first-message", "parent", "partial", "summarized"], "enrichment never removes a row automatically");
    assert.equal(after.find((r) => r.id === "first-message")?.state, "working");
    assert.ok(after.find((r) => r.id === "first-message")?.summary);
    await nativeProof("first-message", after);
    daemon.state.renameThread("first-message", "Pinned invoice export");
    const updateAt = new Date().toISOString();
    transcript("first-message", "Implement CSV export for invoices.", "CSV writer implemented; I am writing its tests next.", updateAt, true);
    await api("/poll", {});
    await waitFor(() => daemon!.state.listEnrichmentCandidates().length === 0, live ? 90_000 : 10_000, "working summary update");
    const updated: SessionStateRow[] = await api("/session-state");
    assert.equal(updated.find((r) => r.id === "first-message")?.state, "working");
    assert.equal(updated.find((r) => r.id === "first-message")?.topic, "Pinned invoice export");
    assert.notEqual(updated.find((r) => r.id === "first-message")?.summary, after.find((r) => r.id === "first-message")?.summary);
    await nativeProof("working-update", updated);
    const childAt = new Date(Date.now() + 1_000).toISOString();
    transcript("child", "Review CSV escaping in the export.", "CSV escaping verified for embedded commas, quotes, and newlines. All checks passed. No findings or owner decision.", childAt);
    await api("/poll", {});
    await waitFor(() => daemon!.state.listEnrichmentCandidates().length === 0, live ? 90_000 : 10_000, "child-only progress refreshes parent summary");
    const childUpdated: SessionStateRow[] = await api("/session-state");
    const updatedParent = childUpdated.find((r) => r.id === "parent")!;
    assert.equal(updatedParent.lastMessageAt, parentAt, "the parent transcript has not advanced");
    assert.equal(updatedParent.state, "working");
    assert.notEqual(updatedParent.summary, updated.find((r) => r.id === "parent")?.summary);
    assert.match(updatedParent.summary!, /escap|comma|quot|newline/i, "the parent summary reflects child-only evidence");
    await nativeProof("child-progress", childUpdated);
    transcript("first-message", "Implement CSV export for invoices.", "CSV writer implemented; I am writing its tests next.", updateAt, false);
    daemon.state.finishAgentRun(activeChild.id, { status: AgentRunStatus.Completed, resultTail: "Export implemented", error: null });
    await api("/poll", {});
    await waitFor(() => daemon!.state.listEnrichmentCandidates().length === 0, live ? 90_000 : 10_000, "direct-to-idle summary update");
    const settled: SessionStateRow[] = await api("/session-state");
    assert.equal(settled.find((r) => r.id === "first-message")?.state, "idle");
    await nativeProof("direct-idle", settled);
    for (const id of ["child", "summarized"]) {
      assert.equal(after.find((r) => r.id === id)?.state, "idle");
      assert.ok(after.find((r) => r.id === id)?.summary);
      assert.ok(after.find((r) => r.id === id)?.generatedTopic);
    }
    await api("/done", { ids: ["child", "summarized"] });
    assert.deepEqual((await api("/session-state") as SessionStateRow[]).map((r) => r.id).sort(), ["decision", "first-message", "parent", "partial"], "only explicit Done removes completed work");
    assert.equal(after.find((r) => r.id === "decision")?.state, "needs-you");
    assert.ok(after.find((r) => r.id === "decision")?.summary);
    assert.equal(after.find((r) => r.id === "partial")?.state, "idle");
    assert.ok(after.find((r) => r.id === "partial")?.summary);
    assert.ok(after.find((r) => r.id === "partial")?.generatedTopic);
    assert.equal(after.find((r) => r.id === "parent")?.state, "working", "working summary preserves the working lifecycle state");
    assert.ok(after.find((r) => r.id === "parent")?.summary, "working rows project their current summary");
    assert.ok(after.find((r) => r.id === "parent")?.generatedTopic, "working rows receive a concise title without waiting to become idle");
    if (!live) assert.equal(after.find((r) => r.id === "parent")?.generatedTopic, "Replacement agent run", "the working summary replaces the stale title");
    assert.ok(attempts.includes("parent"), "visible working rows reconcile through the same worker");
    assert.equal(attempts.filter((id) => id === "partial").length, 2);
    assert.ok(!attempts.includes("outside-window"));
    const count = attempts.length;
    await daemon.close();
    daemon = await boot();
    await api("/poll", {});
    assert.deepEqual((await api("/session-state") as SessionStateRow[]).map((r) => r.id).sort(), ["decision", "first-message", "parent", "partial"]);
    assert.ok((await api("/session-state") as SessionStateRow[]).find((r) => r.id === "parent")?.generatedTopic, "working summary persists across restart");
    assert.equal(attempts.length, count, "restart does not re-enrich unchanged evidence or reopen done work");
    if (live) assert.equal(modelCalls, attempts.length - 1, "every actual model call uses the approved identity; only the controlled outage skips inference");
    console.log(`PASS isolated daemon HTTP widget contract; ${live ? `live Luna medium, ${modelCalls} calls` : "deterministic model seam"}; idle retry, delegated child, child-only progress, working summary, stale-summary recovery, owner decision, window, explicit done only, restart`);
  } finally {
    try {
      const closed = await closeSandboxUser(sandbox, daemon?.port, async () => {
        try { seed?.close(); } finally { await daemon?.close(); }
      });
      console.log("TEARDOWN", JSON.stringify(closed), new Date().toISOString());
      assert.ok(closed.teardownVerified, `proof teardown unverified; diagnostics: ${closed.preservedDiagnostics}`);
    } finally {
      restoreModel();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnvironment);
    }
  }
}

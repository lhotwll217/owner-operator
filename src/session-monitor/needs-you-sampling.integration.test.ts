import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempOoHome } from "../gateway/test/helpers";
import { runTranscriptScan, sampleTurns } from "./scan";

const { dir, cleanup } = tempOoHome("oo-needs-you-sampling");
const originalHome = process.env.HOME;
process.env.HOME = dir;
try {
  const root = join(dir, "cursor");
  const transcripts = join(root, "demo", "agent-transcripts");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(dir, "session_sources.json"), JSON.stringify({ add: [{ source: "cursor", root }] }));
  const say = (role: "user" | "assistant", text: string) => ({ role, message: { content: [{ type: "text", text }] } });
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => [say("user", `old request ${i + 1}`), say("assistant", `reply ${i + 1}`)]).flat(),
    say("user", "current request"),
    ...Array.from({ length: 42 }, (_, i) => say("assistant", `progress ${i + 1}`)),
    say("user", "<system-reminder>injected context</system-reminder>"),
  ];
  writeFileSync(join(transcripts, "long-turn.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
  const id = String((await runTranscriptScan(["--since", "1d"])).threads[0].id);

  assert.deepEqual(await sampleTurns(id), [
    { role: "owner", text: "old request 25" },
    { role: "owner", text: "current request" },
    { role: "agent", text: "progress 41" },
    { role: "agent", text: "progress 42" },
  ], "a long agent turn keeps the owner's latest request, and injected text is not the owner's");

  // The Claude desktop app shows a turn's closing question in a next-step box, which the transcript
  // records only as the wrap_up tool call's input.
  const project = join(dir, ".claude", "projects", "-demo");
  mkdirSync(project, { recursive: true });
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const record = (type: "user" | "assistant", content: unknown[], second: number, stop?: string) => ({
    type, sessionId, cwd: "/demo", timestamp: `2026-11-06T17:25:${String(second).padStart(2, "0")}.000Z`,
    message: { role: type, content, ...(stop ? { stop_reason: stop } : {}) },
  });
  writeFileSync(join(project, `${sessionId}.jsonl`), [
    record("user", [{ type: "text", text: "Why is this readme so big?" }], 1),
    record("assistant", [{ type: "text", text: "Measured the port against upstream." }], 2, "end_turn"),
    record("assistant", [{ type: "tool_use", id: "t1", name: "mcp__ccd_turn__wrap_up", input: {
      recap: "The port carries hand edits in 57 files.",
      ask: "Should I cut the port to the scripted rewrites plus one shim file?",
      actions: [{ label: "Yes, cut to shim" }],
    } }], 3, "tool_use"),
    record("user", [{ type: "tool_result", tool_use_id: "t1", content: "Shown in the next-step box." }], 4),
    record("assistant", [{ type: "text", text: "My recommendation: keep the scripted rewrites and drop the hand edits." }], 5, "end_turn"),
  ].map((row) => JSON.stringify(row)).join("\n"));
  const claudeScan = await runTranscriptScan(["--since", "1970-01-01"]);
  const claude = claudeScan.threads.find((thread) => thread.id === sessionId);
  assert.ok(claude, "the Claude session is scanned");
  assert.equal(claude.working, false, "a turn that ended after the next-step box is not working");
  assert.deepEqual((await sampleTurns(sessionId)).filter((turn) => turn.role === "agent").map((turn) => turn.text), [
    "The port carries hand edits in 57 files. Should I cut the port to the scripted rewrites plus one shim file?",
    "[tool result] Shown in the next-step box.",
    "My recommendation: keep the scripted rewrites and drop the hand edits.",
  ], "the question asked in the next-step box is part of the agent's turn, and a normal end adds no turn end");

  // Record sequences mirror the session-event contract's S3 and S4b fixtures (Claude Code 2.1.280).
  const writeClaude = (id: string, records: Record<string, unknown>[]) => writeFileSync(join(project, `${id}.jsonl`),
    records.map((row) => JSON.stringify({ ...row, sessionId: id })).join("\n"));
  const interruptedId = "22222222-3333-4444-8555-666666666666";
  writeClaude(interruptedId, [
    record("user", [{ type: "text", text: "What does the build script do?" }], 10),
    record("assistant", [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat build.sh" } }], 11, "tool_use"),
    record("user", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "echo building" }] }], 12),
    record("assistant", [{ type: "text", text: "It prints building and exits." }], 13, "end_turn"),
    record("user", [{ type: "text", text: "Run it" }], 14),
    record("assistant", [{ type: "text", text: "Running it." }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "./build.sh" } }], 15, "tool_use"),
    record("user", [{ type: "tool_result", tool_use_id: "t2", content: "The user doesn't want to proceed with this tool use." }], 16),
    record("user", [{ type: "text", text: "[Request interrupted by user for tool use]" }], 17),
  ]);
  assert.deepEqual(await sampleTurns(interruptedId), [
    { role: "owner", text: "What does the build script do?" },
    { role: "agent", text: "[tool result] echo building" },
    { role: "agent", text: "It prints building and exits." },
    { role: "owner", text: "Run it" },
    { role: "agent", text: "Running it." },
    { role: "agent", text: "[tool result] The user doesn't want to proceed with this tool use." },
    { role: "owner", text: "[Request interrupted by user for tool use]" },
    { role: "owner", text: "[Turn ended: the owner interrupted it.]" },
  ], "an interrupted turn keeps its tool results and the interrupt marker, and ends with the turn end");

  const failedId = "33333333-4444-4555-8666-777777777777";
  writeClaude(failedId, [
    record("user", [{ type: "text", text: "Summarise the build log" }], 20),
    { ...record("assistant", [{ type: "text", text: "API Error: the request failed." }], 21, "stop_sequence"), isApiErrorMessage: true, error: "model_not_found" },
  ]);
  assert.deepEqual(await sampleTurns(failedId), [
    { role: "owner", text: "Summarise the build log" },
    { role: "agent", text: "API Error: the request failed." },
    { role: "agent", text: "[Turn ended: the turn failed with an error.]" },
  ], "a failed turn ends with the turn end");
  console.log("ok - Need You sampling takes each side's last two messages from the whole conversation, with tool results, interrupt markers, and the turn end");
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  cleanup();
}
